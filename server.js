const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const redis = require('redis');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── Autenticación Google ─────────────────────────────────────
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
    scopes: SCOPES,
});

const SHEET_ID = process.env.SHEET_ID;

// ─── Cliente Redis ────────────────────────────────────────────
const redisClient = redis.createClient({
    url: process.env.REDIS_URL,
    ...(process.env.REDIS_PASSWORD && { password: process.env.REDIS_PASSWORD }),
    ...(process.env.REDIS_TLS === 'true' && {
        socket: {
            tls: true,
            rejectUnauthorized: false
        }
    })
});

redisClient.on('error', (err) => console.error('Error con Redis:', err));

redisClient.connect()
    .then(() => console.log('Conectado a Redis correctamente'))
    .catch(err => console.error('Error al conectar a Redis:', err));

// ─── Función utilitaria ───────────────────────────────────────
// Calcula los segundos que faltan para la medianoche
// Así los registros del día se limpian automáticamente a las 12:00am
const segundosHastaMedianoche = () => {
    const ahora = new Date();
    const medianoche = new Date();
    medianoche.setHours(24, 0, 0, 0); // Próxima medianoche
    return Math.floor((medianoche - ahora) / 1000);
};

// ─── Middlewares de seguridad ─────────────────────────────────

// 1. Verifica que la petición viene del frontend autorizado
const verificarToken = (req, res, next) => {
    const token = req.headers['x-frontend-token'];

    if (!token || token !== process.env.FRONTEND_KEY_APP) {
        return res.status(401).json({ mensaje: 'No autorizado' });
    }

    next();
};

// 2. Verifica que todos los campos lleguen correctos
const validarDatos = (req, res, next) => {
    const { fechaHora, correo, codigoEstudiante, numeroIdentificacion, programaAcademico, recibo } = req.body;

    if (!fechaHora || !correo || !codigoEstudiante || !numeroIdentificacion || !programaAcademico || !recibo) {
        return res.status(400).json({ mensaje: 'Todos los campos son obligatorios' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(correo)) {
        return res.status(400).json({ mensaje: 'El correo no tiene un formato válido' });
    }

    next();
};

// ─── Lógica principal de registro ────────────────────────────
const handleRequest = async (req, res) => {
    const { fechaHora, correo, codigoEstudiante, numeroIdentificacion, programaAcademico, recibo } = req.body;

    try {
        // 1. Verificar si el estudiante ya registró un bono HOY
        // Usamos codigoEstudiante porque es único por persona
        // El recibo es solo si/no, no sirve para identificar
        const estudianteYaRegistrado = await redisClient.get(`estudiante:${codigoEstudiante}`);
        if (estudianteYaRegistrado) {
            return res.status(400).json({ 
                mensaje: 'Ya registraste un bono hoy con este código de estudiante' 
            });
        }

        // 2. Obtener bonos disponibles desde Redis
        let bonosDisponibles = await redisClient.get('bonos_disponibles');

        // Si Redis no tiene el dato, buscarlo en la hoja de cálculo
        if (!bonosDisponibles) {
            const sheets = google.sheets({ version: 'v4', auth });
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: SHEET_ID,
                range: 'A1',
            });
            bonosDisponibles = parseInt(response.data.values[0][0]);
            await redisClient.set('bonos_disponibles', bonosDisponibles, { EX: 3600 });
        } else {
            bonosDisponibles = parseInt(bonosDisponibles);
        }

        // 3. Verificar si quedan bonos
        if (bonosDisponibles <= 0) {
            return res.status(400).json({ mensaje: '¡Los bonos se han agotado!' });
        }

        // 4. Decrementar bonos en Redis de forma atómica
        // "Atómica" significa que aunque lleguen 800 peticiones al mismo tiempo,
        // Redis las procesa una por una sin perder el conteo
        const nuevosBonos = await redisClient.decr('bonos_disponibles');

        if (nuevosBonos < 0) {
            await redisClient.incr('bonos_disponibles'); // Revertir si quedó negativo
            return res.status(400).json({ mensaje: '¡Los bonos se han agotado!' });
        }

        // 5. Intentar registrar en Google Sheets
        try {
            const sheets = google.sheets({ version: 'v4', auth });

            // Actualizar cantidad de bonos en la hoja
            await sheets.spreadsheets.values.update({
                spreadsheetId: SHEET_ID,
                range: 'A1',
                valueInputOption: 'USER_ENTERED',
                resource: { values: [[nuevosBonos]] },
            });

            // Registrar datos del estudiante en la hoja
            await sheets.spreadsheets.values.append({
                spreadsheetId: SHEET_ID,
                range: 'Hoja1!A2:F',
                valueInputOption: 'USER_ENTERED',
                resource: { 
                    values: [[fechaHora, correo, codigoEstudiante, numeroIdentificacion, programaAcademico, recibo]] 
                },
            });

            // 6. Todo salió bien — marcar estudiante como registrado hasta medianoche
            await redisClient.set(`estudiante:${codigoEstudiante}`, '1', {
                EX: segundosHastaMedianoche()
            });

            res.json({ mensaje: 'Bono registrado exitosamente' });

        } catch (errorSheets) {
            // Si Google Sheets falla, revertimos el bono para que el estudiante pueda reintentar
            console.error('Error con Google Sheets, revirtiendo bono:', errorSheets);
            await redisClient.incr('bonos_disponibles');

            res.status(500).json({ 
                mensaje: 'Error al registrar en la hoja. Tu bono no fue descontado, intenta de nuevo.' 
            });
        }

    } catch (error) {
        console.error('Error general:', error);
        res.status(500).json({ mensaje: 'Error interno del servidor' });
    }
};

// ─── Rutas ────────────────────────────────────────────────────

// Pública — solo lectura, no necesita token
app.get('/bonos/disponibles', async (req, res) => {
    try {
        let bonosDisponibles = await redisClient.get('bonos_disponibles');

        if (!bonosDisponibles) {
            const sheets = google.sheets({ version: 'v4', auth });
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: SHEET_ID,
                range: 'A1',
            });
            bonosDisponibles = parseInt(response.data.values[0][0]);
            await redisClient.set('bonos_disponibles', bonosDisponibles, { EX: 3600 });
        } else {
            bonosDisponibles = parseInt(bonosDisponibles);
        }

        if (bonosDisponibles <= 0) {
            return res.json({ mensaje: '¡Los bonos se han agotado!', bonosDisponibles: 0 });
        }

        res.json({ mensaje: 'Hay bonos disponibles', bonosDisponibles });

    } catch (error) {
        console.error('Error al verificar bonos:', error);
        res.status(500).json({ mensaje: 'Error al verificar los bonos' });
    }
});

// Protegida — registrar bono
app.put('/bonos', verificarToken, validarDatos, async (req, res) => {
    handleRequest(req, res);
});

// Login administrador
app.post('/login', (req, res) => {
    const { usuario, password } = req.body;

    if (usuario === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD) {
        res.json({ exito: true });
    } else {
        res.json({ exito: false });
    }
});

// Protegida — cargar nuevos bonos
app.post('/bonos/cargar', verificarToken, async (req, res) => {
    const { bonos } = req.body;

    try {
        await redisClient.set('bonos_disponibles', bonos, { EX: 3600 });

        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: 'A1',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[bonos]] },
        });

        res.json({ mensaje: 'Bonos actualizados correctamente' });

    } catch (error) {
        console.error('Error al cargar bonos:', error);
        res.status(500).json({ mensaje: 'Error al actualizar los bonos' });
    }
});

// Protegida — sincronizar Redis con Google Sheets
app.get('/sync-bonos', verificarToken, async (req, res) => {
    try {
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: 'A1',
        });
        const bonosDisponibles = parseInt(response.data.values[0][0]);
        await redisClient.set('bonos_disponibles', bonosDisponibles, { EX: 3600 });

        res.json({ mensaje: 'Bonos sincronizados correctamente', bonosDisponibles });

    } catch (error) {
        console.error('Error al sincronizar:', error);
        res.status(500).json({ mensaje: 'Error al sincronizar los bonos' });
    }
});

// ─── Iniciar servidor ─────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});