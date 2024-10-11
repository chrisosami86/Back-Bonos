const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const redis = require('redis');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: 'https://frond-formulario-bienestar.vercel.app',  // Asegura que este sea el dominio correcto del frontend
    methods: 'GET,POST,PUT',  // Define los métodos permitidos
    credentials: true,  // Si necesitas manejar cookies o autenticación
}));

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
    url: process.env.REDIS_URL,
    password: process.env.REDIS_PASSWORD,
    socket: {
        tls: true,
        rejectUnauthorized: false
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
        // Obtener los bonos desde Redis o Google Sheets
        let bonosDisponibles = await redisClient.get('bonos_disponibles');
        if (!bonosDisponibles) {
            const sheets = google.sheets({ version: 'v4', auth });
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: SHEET_ID,
                range: 'A1',
            });
            bonosDisponibles = parseInt(response.data.values[0][0]);

            // Almacenar los bonos en Redis
            await redisClient.set('bonos_disponibles', bonosDisponibles, { EX: 3600 });
        } else {
            bonosDisponibles = parseInt(bonosDisponibles);
        }

        // Verificar si hay bonos disponibles
        if (bonosDisponibles <= 0) {
            return res.status(400).json({ mensaje: '¡Los bonos se han agotado!' });
        }

        // Decrementar los bonos en Redis
        const nuevosBonos = await redisClient.decr('bonos_disponibles');
        if (nuevosBonos < 0) {
            await redisClient.incr('bonos_disponibles');
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

// Ruta para verificar la disponibilidad de bonos
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
            return res.json({ mensaje: '¡Los bonos se han agotado!' });
        }

        res.json({ mensaje: 'Hay bonos disponibles', bonosDisponibles });
    } catch (error) {
        console.error('Error al verificar la disponibilidad de bonos:', error);
        res.status(500).send('Error al verificar la disponibilidad de bonos');
    }
});

// Iniciar el servidor
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
