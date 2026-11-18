/*
 * Configuración global del frontend.
 *
 * IMPORTANTE: se asigna a window.CONFIG (no `const CONFIG`) porque `const` de
 * primer nivel NO crea una propiedad en window. app.js lee window.CONFIG;
 * con `const` la base URL quedaba vacía y las peticiones caían en el origen
 * del frontend (GitHub Pages) en lugar de la API.
 *
 * En producción se puede override con window.API_BASE_URL antes de cargar
 * este archivo, o cambiando el valor por defecto de abajo.
 */
(function (global) {
  var config = global.CONFIG || {};
  if (!config.API_BASE_URL) {
    // Desarrollo local (uvicorn en 127.0.0.1:8000): descomentar esta línea
    // y comentar la de Docker de abajo para volver al entorno de desarrollo.
    // config.API_BASE_URL = global.API_BASE_URL || 'http://127.0.0.1:8000';

    // Docker (nginx + HTTPS): activo por defecto.
    config.API_BASE_URL = global.API_BASE_URL || 'https://localhost';
  }
  global.CONFIG = config;
})(window);
