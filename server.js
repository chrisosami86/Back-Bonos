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

// Ruta para obtener los bonos disponibles
app.get('/bonos', async (req, res) => {
    try {
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: 'A1', // Cambia según la celda donde tienes los bonos
        });
        const bonosDisponibles = parseInt(response.data.values[0][0]);

        res.json({ bonosDisponibles });
    } catch (error) {
        console.error('Error al obtener los bonos disponibles:', error);
        res.status(500).send('Error al obtener los bonos disponibles');
    }
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

// Ruta para registrar datos y actualizar los bonos
app.put('/bonos', async (req, res) => {
    const { nuevosBonos, fechaHora, correo, codigoEstudiante, numeroIdentificacion, programaAcademico, recibo } = req.body;

    try {
        const sheets = google.sheets({ version: 'v4', auth });
        
        // Actualizar los bonos disponibles
        const bodyUpdate = {
            values: [[nuevosBonos]],
        };

        await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: 'A1',
            valueInputOption: 'USER_ENTERED',
            resource: bodyUpdate,
        });

        // Registrar los datos del formulario en una nueva fila
        const registroData = [[fechaHora, correo, codigoEstudiante, numeroIdentificacion, programaAcademico, recibo]];
        
        await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: 'Hoja1!A2:F',
            valueInputOption: 'USER_ENTERED',
            resource: { values: registroData },
        });

        res.send('Bonos actualizados y datos registrados');
    } catch (error) {
        console.error('Error al actualizar los bonos o registrar los datos:', error);
        res.status(500).send('Error al actualizar los bonos o registrar los datos');
    }
});

// Iniciar el servidor
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
