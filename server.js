const express = require("express");
const { google } = require("googleapis");
const cors = require("cors");
const redis = require("redis");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// ─── Autenticación Google ─────────────────────────────────────
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
  scopes: SCOPES,
});

const SHEET_ID = process.env.SHEET_ID;

// ─── Cliente Redis ────────────────────────────────────────────
const redisClient = redis.createClient({
  url: process.env.REDIS_URL,
  ...(process.env.REDIS_PASSWORD && { password: process.env.REDIS_PASSWORD }),
  ...(process.env.REDIS_TLS === "true" && {
    socket: { tls: true, rejectUnauthorized: false },
  }),
});

redisClient.on("error", (err) => console.error("Error con Redis:", err));
redisClient
  .connect()
  .then(() => console.log("Conectado a Redis correctamente"))
  .catch((err) => console.error("Error al conectar a Redis:", err));

// ─── Utilidades ───────────────────────────────────────────────
const segundosHastaMedianoche = () => {
  const ahora = new Date();
  const medianoche = new Date();
  medianoche.setHours(24, 0, 0, 0);
  return Math.floor((medianoche - ahora) / 1000);
};

// ─── Caché en memoria ─────────────────────────────────────────
// Evita parsear el JSON de estudiantes en cada petición
let cacheEstudiantes = null;

// Agrega esta función después de las utilidades
const obtenerEstudiantes = async () => {
    if (cacheEstudiantes) return cacheEstudiantes; // ya está en memoria

    const base = await redisClient.get('base_estudiantes');
    if (!base) return null;

    cacheEstudiantes = JSON.parse(base);
    return cacheEstudiantes;
};

// Reintenta una función hasta N veces con pausa entre intentos
// Esto evita perder registros cuando Sheets falla momentáneamente
const conReintentos = async (fn, intentos = 3, pausaMs = 500) => {
  for (let i = 1; i <= intentos; i++) {
    try {
      return await fn();
    } catch (error) {
      console.error(`Intento ${i} fallido:`, error.message);
      if (i === intentos) throw error; // Si fue el último intento, lanzar el error
      await new Promise((r) => setTimeout(r, pausaMs * i)); // Pausa progresiva
    }
  }
};

// ─── Middlewares de seguridad ─────────────────────────────────
const verificarToken = (req, res, next) => {
  const token = req.headers["x-frontend-token"];
  if (!token || token !== process.env.FRONTEND_KEY_APP) {
    return res.status(401).json({ mensaje: "No autorizado" });
  }
  next();
};

const validarDatos = (req, res, next) => {
  const { codigoEstudiante } = req.body;
  if (!codigoEstudiante) {
    return res
      .status(400)
      .json({ mensaje: "El código de estudiante es obligatorio" });
  }
  next();
};

// ─── Lógica principal de registro ────────────────────────────
const handleRequest = async (req, res) => {
    const { codigoEstudiante } = req.body;

    try {
        // 1. Verificar si ya registró hoy
        const yaRegistrado = await redisClient.get(`registrado:${codigoEstudiante}`);
        if (yaRegistrado) {
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
            return res.status(404).json({ mensaje: 'Código no encontrado' });
        }

        // 3. Verificar bonos disponibles
        let bonosDisponibles = await redisClient.get('bonos_disponibles');
        if (!bonosDisponibles) {
            const sheets = google.sheets({ version: 'v4', auth });
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: SHEET_ID, range: 'A1',
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

        // 5. Guardar registro en Redis — sincronizado: false siempre
        // Ya NO intentamos escribir en Sheets aquí
        // La monitora lo hará manualmente registro por registro
        const fechaHora = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
        const registro = {
            fechaHora,
            codigo: codigoEstudiante,
            documento: estudiante.documento_identidad,
            nombre: estudiante.nombre,
            email: estudiante.email,
            programa: estudiante.programa_academico,
            recibo: 'SI',
            codBono: null,        // ← se llenará cuando la monitora lo asigne
            sincronizado: false,  // ← siempre empieza pendiente
        };

        await redisClient.set(
            `registrado:${codigoEstudiante}`,
            JSON.stringify(registro),
            { EX: segundosHastaMedianoche() }
        );

        res.json({ mensaje: 'Bono registrado exitosamente' });

    } catch (error) {
        console.error('Error general:', error);
        res.status(500).json({ mensaje: 'Error interno del servidor' });
    }
};

// ─── Rutas ────────────────────────────────────────────────────

// Pública — bonos disponibles
app.get('/bonos/disponibles', async (req, res) => {
    try {
        const bonosDisponibles = await redisClient.get('bonos_disponibles');

        // Si Redis no tiene el dato, significa que no se han cargado bonos aún
        if (!bonosDisponibles) {
            return res.json({ mensaje: 'No hay bonos cargados', bonosDisponibles: 0 });
        }

        const cantidad = parseInt(bonosDisponibles);

        if (cantidad <= 0) {
            return res.json({ mensaje: '¡Los bonos se han agotado!', bonosDisponibles: 0 });
        }

        res.json({ mensaje: 'Hay bonos disponibles', bonosDisponibles: cantidad });

    } catch (error) {
        console.error('Error al verificar bonos:', error);
        res.status(500).json({ mensaje: 'Error al verificar los bonos' });
    }
});

// Protegida — registrar bono
app.put("/bonos", verificarToken, validarDatos, async (req, res) => {
  handleRequest(req, res);
});

// Login administrador
app.post("/login", (req, res) => {
  const { usuario, password } = req.body;
  if (
    usuario === process.env.ADMIN_USER &&
    password === process.env.ADMIN_PASSWORD
  ) {
    res.json({ exito: true });
  } else {
    res.json({ exito: false });
  }
});

// Protegida — cargar nuevos bonos
app.post('/bonos/cargar', verificarToken, async (req, res) => {
    const { bonos } = req.body;
    try {
        // Guardar en Redis — fuente principal de verdad
        await redisClient.set('bonos_disponibles', bonos);

        // Guardar en Sheets solo como respaldo/referencia
        // Es una sola escritura, no hay concurrencia aquí
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

// Protegida — obtener todos los registros del día desde Redis
app.get("/registros/hoy", verificarToken, async (req, res) => {
  try {
    // Buscar todas las claves que empiecen con "registrado:"
    const claves = await redisClient.keys("registrado:*");

    if (claves.length === 0) {
      return res.json({ registros: [], total: 0 });
    }

    // Obtener el valor de cada clave
    // Promise.all ejecuta todas las consultas al mismo tiempo, más eficiente
    const valores = await Promise.all(
      claves.map((clave) => redisClient.get(clave)),
    );

    // Convertir cada valor de texto a objeto
    const registros = valores
      .map((v) => JSON.parse(v))
      .sort((a, b) => a.fechaHora.localeCompare(b.fechaHora)); // ordenar por hora

    res.json({ registros, total: registros.length });
  } catch (error) {
    console.error("Error al obtener registros:", error);
    res.status(500).json({ mensaje: "Error al obtener los registros" });
  }
});



// Pública — buscar estudiante por código
app.get("/estudiante/:codigo", async (req, res) => {
  const { codigo } = req.params;
  try {
    const baseEstudiantes = await redisClient.get("base_estudiantes");
    if (!baseEstudiantes) {
      return res.status(404).json({ mensaje: "Base de datos no disponible" });
    }
    const estudiantes = JSON.parse(baseEstudiantes);
    const estudiante = estudiantes[codigo];
    if (!estudiante) {
      return res.status(404).json({ mensaje: "Código no encontrado" });
    }
    res.json({ estudiante });
  } catch (error) {
    console.error("Error al buscar estudiante:", error);
    res.status(500).json({ mensaje: "Error al buscar el estudiante" });
  }
});

// Pública — verificar si un estudiante ya registró hoy
// Ahora devuelve el registro completo si existe
app.get("/estudiante/:codigo/registro", async (req, res) => {
  const { codigo } = req.params;
  try {
    const valor = await redisClient.get(`registrado:${codigo}`);
    if (!valor) {
      return res.json({ yaRegistrado: false });
    }
    const registro = JSON.parse(valor);
    res.json({ yaRegistrado: true, registro });
  } catch (error) {
    console.error("Error al verificar registro:", error);
    res.status(500).json({ mensaje: "Error al verificar registro" });
  }
});

// Protegida — cargar base de datos de estudiantes
app.post("/estudiantes/cargar", verificarToken, async (req, res) => {
  const { estudiantes } = req.body;
  if (!estudiantes || typeof estudiantes !== "object") {
    return res.status(400).json({ mensaje: "Datos de estudiantes inválidos" });
  }
  try {
    await redisClient.set("base_estudiantes", JSON.stringify(estudiantes));
    cacheEstudiantes = null;
    const total = Object.keys(estudiantes).length;
    res.json({ mensaje: "Base de datos cargada correctamente", total });
  } catch (error) {
    console.error("Error al cargar estudiantes:", error);
    res.status(500).json({ mensaje: "Error al cargar la base de datos" });
  }
});

// Protegida — enviar un registro individual a Google Sheets
app.post('/registros/enviar', verificarToken, async (req, res) => {
    const { codigo, codBono } = req.body;

    if (!codigo) {
        return res.status(400).json({ mensaje: 'El código es obligatorio' });
    }

    if (!codBono && codBono !== 0) {
        return res.status(400).json({ mensaje: 'El número de bono es obligatorio' });
    }

    try {
        // Obtener el registro desde Redis
        const valor = await redisClient.get(`registrado:${codigo}`);
        if (!valor) {
            return res.status(404).json({ mensaje: 'Registro no encontrado' });
        }

        const registro = JSON.parse(valor);

        if (registro.sincronizado) {
            return res.status(400).json({ mensaje: 'Este registro ya fue sincronizado' });
        }

        // Intentar escribir en Sheets — un solo registro, no satura la API
        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: 'hoja1!A2:H',  // H porque ahora hay 8 columnas
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[
                    registro.fechaHora,
                    registro.codigo,
                    registro.documento,
                    registro.nombre,
                    registro.email,
                    registro.programa,
                    registro.recibo,
                    codBono  // ← columna nueva
                ]]
            },
        });

        // Sheets funcionó — actualizar registro en Redis
        registro.codBono = codBono;
        registro.sincronizado = true;

        await redisClient.set(
            `registrado:${codigo}`,
            JSON.stringify(registro),
            { KEEPTTL: true }
        );

        res.json({ mensaje: 'Registro enviado correctamente' });

    } catch (error) {
        console.error('Error al enviar registro:', error.message);
        // No marcamos como sincronizado — la monitora puede reintentar
        res.status(500).json({ mensaje: 'Error al enviar a Google Sheets, intenta de nuevo' });
    }
});

// ─── Iniciar servidor ─────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
