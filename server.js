const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const redis = require('redis');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json({limit: '50mb'}));

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
    const { codigoEstudiante } = req.body;

    // Ahora solo validamos que venga el código
    // Los demás datos los trae el backend desde Redis
    if (!codigoEstudiante) {
        return res.status(400).json({ mensaje: 'El código de estudiante es obligatorio' });
    }

    next();
};

// ─── Lógica principal de registro ────────────────────────────
const handleRequest = async (req, res) => {
    const { codigoEstudiante } = req.body;

    try {
        // 1. Verificar si el estudiante ya registró hoy
        const estudianteYaRegistrado = await redisClient.get(`registrado:${codigoEstudiante}`);
        if (estudianteYaRegistrado) {
            return res.status(400).json({ 
                mensaje: 'Ya registraste un bono hoy con este código' 
            });
        }

        // 2. Buscar datos del estudiante en Redis
        const baseEstudiantes = await redisClient.get('base_estudiantes');
        if (!baseEstudiantes) {
            return res.status(500).json({ mensaje: 'Base de datos no disponible' });
        }

        const estudiantes = JSON.parse(baseEstudiantes);
        const estudiante = estudiantes[codigoEstudiante];

        if (!estudiante) {
            return res.status(404).json({ 
                mensaje: 'Código no encontrado, verifica que sea correcto' 
            });
        }

        // 3. Verificar bonos disponibles
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
            return res.status(400).json({ mensaje: '¡Los bonos se han agotado!' });
        }

        // 4. Decrementar bonos de forma atómica
        const nuevosBonos = await redisClient.decr('bonos_disponibles');
        if (nuevosBonos < 0) {
            await redisClient.incr('bonos_disponibles');
            return res.status(400).json({ mensaje: '¡Los bonos se han agotado!' });
        }

        // 5. Registrar en Google Sheets
        try {
            const sheets = google.sheets({ version: 'v4', auth });
            const fechaHora = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });

            await sheets.spreadsheets.values.update({
                spreadsheetId: SHEET_ID,
                range: 'A1',
                valueInputOption: 'USER_ENTERED',
                resource: { values: [[nuevosBonos]] },
            });

            await sheets.spreadsheets.values.append({
                spreadsheetId: SHEET_ID,
                range: 'Hoja1!A2:F',
                valueInputOption: 'USER_ENTERED',
                resource: { 
                    values: [[
                        fechaHora,
                        codigoEstudiante,
                        estudiante.documento_identidad,
                        estudiante.nombre,
                        estudiante.email,
                        estudiante.programa_academico,
                        'SI'  // recibo siempre es SI
                    ]] 
                },
            });

            // 6. Marcar estudiante como registrado hasta medianoche
            await redisClient.set(`registrado:${codigoEstudiante}`, '1', {
                EX: segundosHastaMedianoche()
            });

            res.json({ mensaje: 'Bono registrado exitosamente' });

        } catch (errorSheets) {
            console.error('Error con Google Sheets, revirtiendo:', errorSheets);
            await redisClient.incr('bonos_disponibles');
            res.status(500).json({ 
                mensaje: 'Error al registrar. Tu bono no fue descontado, intenta de nuevo.' 
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

// Protegida — cargar base de datos de estudiantes (usar cada semestre)
app.post('/estudiantes/cargar', verificarToken, async (req, res) => {
    const { estudiantes } = req.body;

    // Verificar que llegó la data
    if (!estudiantes || typeof estudiantes !== 'object') {
        return res.status(400).json({ mensaje: 'Datos de estudiantes inválidos' });
    }

    try {
        // Guardamos todos los estudiantes en un solo key en Redis
        // JSON.stringify convierte el objeto a texto para poder guardarlo
        await redisClient.set('base_estudiantes', JSON.stringify(estudiantes));

        const total = Object.keys(estudiantes).length;
        res.json({ mensaje: `Base de datos cargada correctamente`, total });

    } catch (error) {
        console.error('Error al cargar estudiantes:', error);
        res.status(500).json({ mensaje: 'Error al cargar la base de datos' });
    }
});

// Pública — buscar estudiante por código
app.get('/estudiante/:codigo', async (req, res) => {
    const { codigo } = req.params;

    try {
        // Obtener toda la base de estudiantes desde Redis
        const baseEstudiantes = await redisClient.get('base_estudiantes');

        if (!baseEstudiantes) {
            return res.status(404).json({ 
                mensaje: 'Base de datos no disponible, contacta al administrador' 
            });
        }

        // JSON.parse convierte el texto de Redis de vuelta a objeto
        const estudiantes = JSON.parse(baseEstudiantes);
        const estudiante = estudiantes[codigo];

        if (!estudiante) {
            return res.status(404).json({ 
                mensaje: 'Código no encontrado, verifica que sea correcto' 
            });
        }

        res.json({ estudiante });

    } catch (error) {
        console.error('Error al buscar estudiante:', error);
        res.status(500).json({ mensaje: 'Error al buscar el estudiante' });
    }
});

// Pública — verificar si un estudiante ya registró hoy
app.get('/estudiante/:codigo/registro', async (req, res) => {
    const { codigo } = req.params;
    try {
        const yaRegistrado = await redisClient.get(`registrado:${codigo}`);
        res.json({ yaRegistrado: !!yaRegistrado });
    } catch (error) {
        console.error('Error al verificar registro:', error);
        res.status(500).json({ mensaje: 'Error al verificar registro' });
    }
});

// ─── Iniciar servidor ─────────────────────────────────────────
app.listen(PORT,'0.0.0.0', () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});