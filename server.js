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
    // 1. Verificar si el estudiante ya registró hoy
    const yaRegistrado = await redisClient.get(
      `registrado:${codigoEstudiante}`,
    );
    if (yaRegistrado) {
      return res.status(400).json({
        mensaje: "Ya registraste un bono hoy con este código",
      });
    }

    // 2. Buscar datos del estudiante en Redis
    const baseEstudiantes = await redisClient.get("base_estudiantes");
    if (!baseEstudiantes) {
      return res.status(500).json({ mensaje: "Base de datos no disponible" });
    }

    const estudiantes = JSON.parse(baseEstudiantes);
    const estudiante = estudiantes[codigoEstudiante];

    if (!estudiante) {
      return res.status(404).json({
        mensaje: "Código no encontrado, verifica que sea correcto",
      });
    }

    // 3. Verificar bonos disponibles
    let bonosDisponibles = await redisClient.get("bonos_disponibles");
    if (!bonosDisponibles) {
      const sheets = google.sheets({ version: "v4", auth });
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: "A1",
      });
      bonosDisponibles = parseInt(response.data.values[0][0]);
      await redisClient.set("bonos_disponibles", bonosDisponibles, {
        EX: 3600,
      });
    } else {
      bonosDisponibles = parseInt(bonosDisponibles);
    }

    if (bonosDisponibles <= 0) {
      return res.status(400).json({ mensaje: "¡Los bonos se han agotado!" });
    }

    // 4. Decrementar bonos de forma atómica
    const nuevosBonos = await redisClient.decr("bonos_disponibles");
    if (nuevosBonos < 0) {
      await redisClient.incr("bonos_disponibles");
      return res.status(400).json({ mensaje: "¡Los bonos se han agotado!" });
    }

    // 5. Armar el objeto del registro completo
    const fechaHora = new Date().toLocaleString("es-CO", {
      timeZone: "America/Bogota",
    });
    const registro = {
      fechaHora,
      codigo: codigoEstudiante,
      documento: estudiante.documento_identidad,
      nombre: estudiante.nombre,
      email: estudiante.email,
      programa: estudiante.programa_academico,
      recibo: "SI",
      sincronizado: false, // ← empieza como pendiente
    };

    // 6. Guardar registro completo en Redis ANTES de intentar Sheets
    // Así aunque Sheets falle, los datos están seguros
    const expiracion = { EX: segundosHastaMedianoche() };
    await redisClient.set(
      `registrado:${codigoEstudiante}`,
      JSON.stringify(registro),
      expiracion,
    );

    // 7. Intentar escribir en Sheets con hasta 3 reintentos
    let sheets_exitoso = false;

    try {
      await conReintentos(async () => {
        const sheets = google.sheets({ version: "v4", auth });

        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: "A1",
          valueInputOption: "USER_ENTERED",
          resource: { values: [[nuevosBonos]] },
        });

        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: "hoja1!A2:G",
          valueInputOption: "USER_ENTERED",
          resource: {
            values: [
              [
                registro.fechaHora,
                registro.codigo,
                registro.documento,
                registro.nombre,
                registro.email,
                registro.programa,
                registro.recibo,
              ],
            ],
          },
        });

        sheets_exitoso = true; // ← solo llega aquí si TODO funcionó
      });
    } catch (errorSheets) {
      console.error("Sheets falló después de 3 intentos:", errorSheets.message);
      sheets_exitoso = false;
    }

    // Solo marcar sincronizado si Sheets realmente funcionó
    if (sheets_exitoso) {
      registro.sincronizado = true;
      await redisClient.set(
        `registrado:${codigoEstudiante}`,
        JSON.stringify(registro),
        expiracion,
      );
    }

    res.json({ mensaje: "Bono registrado exitosamente" });
  } catch (error) {
    console.error("Error general:", error);
    res.status(500).json({ mensaje: "Error interno del servidor" });
  }
};

// ─── Rutas ────────────────────────────────────────────────────

// Pública — bonos disponibles
app.get("/bonos/disponibles", async (req, res) => {
  try {
    let bonosDisponibles = await redisClient.get("bonos_disponibles");
    if (!bonosDisponibles) {
      const sheets = google.sheets({ version: "v4", auth });
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: "A1",
      });
      bonosDisponibles = parseInt(response.data.values[0][0]);
      await redisClient.set("bonos_disponibles", bonosDisponibles, {
        EX: 3600,
      });
    } else {
      bonosDisponibles = parseInt(bonosDisponibles);
    }

    if (bonosDisponibles <= 0) {
      return res.json({
        mensaje: "¡Los bonos se han agotado!",
        bonosDisponibles: 0,
      });
    }
    res.json({ mensaje: "Hay bonos disponibles", bonosDisponibles });
  } catch (error) {
    console.error("Error al verificar bonos:", error);
    res.status(500).json({ mensaje: "Error al verificar los bonos" });
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
app.post("/bonos/cargar", verificarToken, async (req, res) => {
  const { bonos } = req.body;
  try {
    await redisClient.set("bonos_disponibles", bonos, { EX: 3600 });
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "A1",
      valueInputOption: "USER_ENTERED",
      resource: { values: [[bonos]] },
    });
    res.json({ mensaje: "Bonos actualizados correctamente" });
  } catch (error) {
    console.error("Error al cargar bonos:", error);
    res.status(500).json({ mensaje: "Error al actualizar los bonos" });
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

// Protegida — sincronizar registros pendientes con Google Sheets
app.post('/registros/sincronizar', verificarToken, async (req, res) => {
    try {
        const claves = await redisClient.keys('registrado:*');

        if (claves.length === 0) {
            return res.json({ mensaje: 'No hay registros para sincronizar', sincronizados: 0 });
        }

        const valores = await Promise.all(claves.map(c => redisClient.get(c)));
        const todos = valores.map(v => JSON.parse(v));
        const pendientes = todos.filter(r => r.sincronizado === false);

        if (pendientes.length === 0) {
            return res.json({ mensaje: 'Todos los registros ya están sincronizados', sincronizados: 0 });
        }

        const filas = pendientes.map(r => [
            r.fechaHora, r.codigo, r.documento,
            r.nombre, r.email, r.programa, r.recibo
        ]);

        // Intentar escribir en Sheets
        await conReintentos(async () => {
            const sheets = google.sheets({ version: 'v4', auth });
            await sheets.spreadsheets.values.append({
                spreadsheetId: SHEET_ID,
                range: 'hoja1!A2:G',
                valueInputOption: 'USER_ENTERED',
                resource: { values: filas },
            });
        });

        // ✅ Solo llega aquí si Sheets funcionó realmente
        await Promise.all(
            pendientes.map(r => {
                r.sincronizado = true;
                return redisClient.set(
                    `registrado:${r.codigo}`,
                    JSON.stringify(r),
                    { KEEPTTL: true }
                );
            })
        );

        res.json({
            mensaje: `${pendientes.length} registros sincronizados correctamente`,
            sincronizados: pendientes.length
        });

    } catch (error) {
        // ✅ Si Sheets falló, no se marca nada como sincronizado
        // El admin puede intentar de nuevo
        console.error('Error al sincronizar:', error);
        res.status(500).json({ 
            mensaje: 'Error al sincronizar. Los registros siguen pendientes, intenta de nuevo.',
        });
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
    const total = Object.keys(estudiantes).length;
    res.json({ mensaje: "Base de datos cargada correctamente", total });
  } catch (error) {
    console.error("Error al cargar estudiantes:", error);
    res.status(500).json({ mensaje: "Error al cargar la base de datos" });
  }
});

// ─── Iniciar servidor ─────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
