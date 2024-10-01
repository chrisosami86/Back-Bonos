# Formulario de registro de alimentación (Backend)

* Esta es una aplicación que permite registrar la entrega de bonos de alimentación en una hoja de Google Sheet
* Esta aplicación usa la Api de Google Sheet
* Es necesario que se tenga todo configurado en Google Console

# Para correr la aplicación en local

**1.** Instalar los paquetes de Node ```npm install```

**2.** Crear un archivo ```.env``` para configurar las variables de entorno

**3.** Debes tener creada una cuenta de servicio en Google Console

**4.** Descarga él .JSON de las credenciales de la cuenta de servicio

**5.** Dentro del archivo ```.env``` debe tener las siguientes variables.

* **SHEET_ID =** El ID de la hoja de cálculo donde necesitamos los registros (Sin comillas)
* **GOOGLE_APPLICATION_CREDENTIALS_JSON =** 'Todo el contenido del archivo de credenciales ```.JSON``` de Google' (dentro de las comillas);

**7.** Node server.js en la terminal y probar
