const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;
require('dotenv').config();

// Middleware
app.use(cors());
app.use(express.json());

// Autenticación con las credenciales de servicio
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
    scopes: SCOPES,
});

// Configura el ID de tu hoja de cálculo
const SHEET_ID = process.env.SHEET_ID;

// Mutex para bloquear las peticiones concurrentes
let lock = false;
let waitingQueue = [];  // Cola para manejar solicitudes en espera

// Función para procesar la cola de espera
const processWaitingQueue = () => {
    if (waitingQueue.length > 0 && !lock) {
        const nextRequest = waitingQueue.shift();
        handleRequest(nextRequest.req, nextRequest.res);
    }
};

// Función para manejar la solicitud de actualización y registro de datos
const handleRequest = async (req, res) => {
    if (lock) {
        // Si está bloqueado, añadimos la solicitud a la cola de espera
        return waitingQueue.push({ req, res });
    }

    lock = true;  // Bloqueamos el acceso mientras procesamos la solicitud

    const { fechaHora, correo, codigoEstudiante, numeroIdentificacion, programaAcademico, recibo } = req.body;

    try {
        const sheets = google.sheets({ version: 'v4', auth });

        // Leer los bonos disponibles
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: 'A1',
        });
        let bonosDisponibles = parseInt(response.data.values[0][0]);

        // Verificar si hay bonos disponibles
        if (bonosDisponibles <= 0) {
            return res.status(400).json({ mensaje: '¡Los bonos se han agotado!' });
        }

        // Actualizar los bonos disponibles y restar 1
        const nuevosBonos = bonosDisponibles - 1;
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
    } finally {
        lock = false;  // Liberar el bloqueo
        processWaitingQueue();  // Procesar la siguiente solicitud en la cola
    }
};

// Ruta principal que maneja la actualización de bonos y registro
app.put('/bonos', async (req, res) => {
    handleRequest(req, res);
});

// Ruta para verificar la disponibilidad de bonos
app.get('/bonos/disponibles', async (req, res) => {
    try {
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: 'A1',
        });
        const bonosDisponibles = parseInt(response.data.values[0][0]);

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
