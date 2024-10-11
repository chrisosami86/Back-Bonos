const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const redis = require('redis');
require('dotenv').config();



const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Autenticación con las credenciales de servicio de Google
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
    scopes: SCOPES,
});

// Configura el ID de tu hoja de cálculo
const SHEET_ID = process.env.SHEET_ID;

// Crear el cliente Redis conectado a Upstash
const redisClient = redis.createClient({
    url: process.env.REDIS_URL,  // URL de Redis proporcionada por Upstash
    password: process.env.REDIS_PASSWORD,  // Contraseña proporcionada por Upstash
    socket: {
        tls: true,  // Usar TLS/SSL ya que está habilitado en Upstash
        rejectUnauthorized: false  // Asegura que el certificado SSL no sea rechazado
    }
});

redisClient.on('error', (err) => console.error('Error con Redis:', err));

// Conectarse a Redis
redisClient.connect().then(() => {
    console.log('Conectado a Redis en Upstash');
}).catch(err => console.error('Error al conectar a Redis:', err));

// Función para manejar la solicitud de actualización y registro de datos
const handleRequest = async (req, res) => {
    const { fechaHora, correo, codigoEstudiante, numeroIdentificacion, programaAcademico, recibo } = req.body;

    try {
        // Intentar obtener los bonos disponibles desde Redis
        let bonosDisponibles = await redisClient.get('bonos_disponibles');
        
        // Si no hay bonos en Redis, obtenerlos de la hoja de cálculo y almacenarlos en Redis
        if (!bonosDisponibles) {
            const sheets = google.sheets({ version: 'v4', auth });
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: SHEET_ID,
                range: 'A1',
            });
            bonosDisponibles = parseInt(response.data.values[0][0]);

            // Almacenar los bonos en Redis con una expiración opcional (en segundos, 1 hora por ejemplo)
            await redisClient.set('bonos_disponibles', bonosDisponibles, { EX: 3600 });
        } else {
            bonosDisponibles = parseInt(bonosDisponibles);
        }

        // Verificar si hay bonos disponibles
        if (bonosDisponibles <= 0) {
            return res.status(400).json({ mensaje: '¡Los bonos se han agotado!' });
        }

        // Decrementar los bonos en Redis de forma atómica
        const nuevosBonos = await redisClient.decr('bonos_disponibles');

        // Si después de decrementar los bonos es menor a cero, restauramos el valor anterior
        if (nuevosBonos < 0) {
            await redisClient.incr('bonos_disponibles');  // Revertir el decremento
            return res.status(400).json({ mensaje: '¡Los bonos se han agotado!' });
        }

        // Actualizar los bonos en Google Sheets
        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: 'A1',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[nuevosBonos]] },
        });

        // Registrar los datos del formulario en una nueva fila
        const registroData = [[fechaHora, correo, codigoEstudiante, numeroIdentificacion, programaAcademico, recibo]];
        await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: 'Hoja1!A2:F',
            valueInputOption: 'USER_ENTERED',
            resource: { values: registroData },
        });

        res.send('Bono registrado exitosamente y bonos actualizados.');
    } catch (error) {
        console.error('Error al actualizar los bonos o registrar los datos:', error);
        res.status(500).send('Error al actualizar los bonos o registrar los datos');
    }
};

// Sincronizar bonos en Redis con Google Sheets
app.get('/sync-bonos', async (req, res) => {
    try {
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: 'A1',
        });
        const bonosDisponibles = parseInt(response.data.values[0][0]);

        // Actualizar Redis con el valor más reciente
        await redisClient.set('bonos_disponibles', bonosDisponibles, { EX: 3600 });
        res.json({ mensaje: 'Bonos sincronizados correctamente', bonosDisponibles });
    } catch (error) {
        console.error('Error al sincronizar los bonos:', error);
        res.status(500).send('Error al sincronizar los bonos');
    }
});

// Ruta principal que maneja la actualización de bonos y registro
app.put('/bonos', async (req, res) => {
    handleRequest(req, res);
});

// Ruta para verificar la disponibilidad de bonos
app.get('/bonos/disponibles', async (req, res) => {
    try {
        // Intentar obtener los bonos disponibles desde Redis
        let bonosDisponibles = await redisClient.get('bonos_disponibles');
        
        // Si no hay bonos en Redis, obtenerlos de la hoja de cálculo
        if (!bonosDisponibles) {
            const sheets = google.sheets({ version: 'v4', auth });
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: SHEET_ID,
                range: 'A1',
            });
            bonosDisponibles = parseInt(response.data.values[0][0]);

            // Almacenar los bonos en Redis con expiración opcional
            await redisClient.set('bonos_disponibles', bonosDisponibles, { EX: 3600 });
        } else {
            bonosDisponibles = parseInt(bonosDisponibles);
        }

        if (bonosDisponibles <= 0) {
            return res.json({ mensaje: '¡Los bonos se han agotado!' });
        }

        res.json({ mensaje: 'Hay bonos disponibles', bonosDisponibles });
    } catch (error) {
        console.error('Error al verificar la disponibilidad de bonos:', error);
        res.status(500).send('Error al verificar la disponibilidad de bonos');
    }
});

// Ruta de inicio de sesión
app.post('/login', (req, res) => {
    const { usuario, password } = req.body;

    if (usuario === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD) {
        res.json({ exito: true });
    } else {
        res.json({ exito: false });
    }
});

// Ruta para cargar nuevos bonos desde el administrador
app.post('/bonos/cargar', async (req, res) => {
    const { bonos } = req.body;

    try {
        // Actualizar en Redis
        await redisClient.set('bonos_disponibles', bonos, { EX: 3600 });

        // Actualizar en Google Sheets
        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: 'A1',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[bonos]] },
        });

        res.json({ mensaje: 'Bonos actualizados correctamente' });
    } catch (error) {
        console.error('Error al actualizar los bonos:', error);
        res.status(500).json({ mensaje: 'Error al actualizar los bonos' });
    }
});

// Iniciar el servidor
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
