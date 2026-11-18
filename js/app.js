/*
 * app.js — Único cliente HTTP y capa de sesión del frontend.
 *
 * Responsabilidades:
 *  - Guardar el token en sessionStorage (nunca en localStorage) y migrar
 *    cualquier sesión heredada de versiones anteriores.
 *  - Verificar expiración del JWT antes de cada llamada y hacer re-login limpio
 *    ante 401/403 de sesión.
 *  - Centralizar fetch: headers, errores, deduplicación de requests en vuelo,
 *    caché ETag de catálogos y AbortController para búsquedas.
 *  - Guards por rol y registro del service worker PWA.
 *
 * Todas las pantallas deben usar API.get/post/put en lugar de fetch directo.
 */
(function (global) {
  'use strict';

  var TOKEN_KEY = 'jwt_token';
  var USER_KEY = 'usuario';
  var MENSAJE_KEY = 'mensaje_sesion';
  var LEGACY_KEYS = [TOKEN_KEY, USER_KEY];
  var store = global.sessionStorage;

  // Migración única desde localStorage -> sessionStorage.
  (function migrarSesionLegacy() {
    try {
      var tokenLegacy = global.localStorage.getItem(TOKEN_KEY);
      if (tokenLegacy && !store.getItem(TOKEN_KEY)) {
        store.setItem(TOKEN_KEY, tokenLegacy);
        var usuarioLegacy = global.localStorage.getItem(USER_KEY);
        if (usuarioLegacy) store.setItem(USER_KEY, usuarioLegacy);
      }
      LEGACY_KEYS.forEach(function (k) {
        global.localStorage.removeItem(k);
      });
    } catch (err) {
      store = {
        getItem: function () { return null; },
        setItem: function () {},
        removeItem: function () {}
      };
    }
  })();

  function ApiError(status, detail, data) {
    var error = new Error(detail || 'Error inesperado en la solicitud.');
    error.name = 'ApiError';
    error.status = status;
    error.detail = detail;
    error.data = data || null;
    return error;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  var requestsEnVuelo = new Map();
  var cacheEtag = new Map();

  function baseUrl() {
    var config = global.CONFIG;
    // Compatibilidad con versiones anteriores de config.js que declaraban
    // `const CONFIG`: ese enlace no era propiedad de window pero sí existe en
    // el ámbito global de los scripts clásicos.
    if (!config && typeof CONFIG !== 'undefined') config = CONFIG;
    return (config && config.API_BASE_URL) || '';
  }

  function token() {
    return store.getItem(TOKEN_KEY);
  }

  function usuario() {
    var raw = store.getItem(USER_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (err) { return null; }
  }

  function restr(rol) {
    var u = usuario();
    if (u && u.rol) return u.rol === rol;
    var t = token();
    if (!t) return false;
    try {
      var payload = JSON.parse(
        global.atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
      );
      return payload.rol === rol;
    } catch (err) {
      return false;
    }
  }

  function tokenExpirado(t) {
    if (!t) return true;
    try {
      var payload = JSON.parse(
        global.atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
      );
      return !payload.exp || payload.exp * 1000 <= Date.now();
    } catch (err) {
      return true;
    }
  }

  function sesionValida() {
    return !!token() && !tokenExpirado(token());
  }

  function limpiarSesion() {
    LEGACY_KEYS.forEach(function (k) {
      store.removeItem(k);
      global.localStorage.removeItem(k);
    });
    cacheEtag.clear();
  }

  function guardarSesion(data) {
    if (!data || !data.access_token) throw new Error('Respuesta de login inválida.');
    store.setItem(TOKEN_KEY, data.access_token);
    if (data.usuario) store.setItem(USER_KEY, JSON.stringify(data.usuario));
    global.localStorage.removeItem(TOKEN_KEY);
    global.localStorage.removeItem(USER_KEY);
  }

  function destinoPorRol(rol) {
    return rol === 'admin' ? 'dashboard.html' : 'dashboard_experto.html';
  }

  function irALogin(mensaje) {
    limpiarSesion();
    if (mensaje) {
      try { store.setItem(MENSAJE_KEY, mensaje); } catch (err) { /* noop */ }
    }
    global.location.href = 'index.html';
  }

  function verificarSesion() {
    if (!sesionValida()) {
      irALogin('Tu sesión expiró. Ingresá nuevamente para continuar.');
      return false;
    }
    return true;
  }

  // Guard de navegación: redirige a la página correcta si el rol no coincide.
  function requerirRol(rol) {
    if (!verificarSesion()) return false;
    if (!restr(rol)) {
      var u = usuario();
      global.location.href = destinoPorRol(u && u.rol);
      return false;
    }
    return true;
  }

  function cerrarSesion() {
    global.location.href = 'index.html';
    limpiarSesion();
  }

  function getAuthHeaders() {
    return {
      'Accept': 'application/json',
      'Authorization': 'Bearer ' + (token() || '')
    };
  }

  function construirUrl(path, params) {
    var url = baseUrl() + path;
    if (!params) return url;
    if (params instanceof URLSearchParams) {
      var cadena = params.toString();
      return cadena ? url + (url.indexOf('?') >= 0 ? '&' : '?') + cadena : url;
    }
    var partes = [];
    Object.keys(params).forEach(function (clave) {
      var valor = params[clave];
      if (valor === undefined || valor === null || valor === '') return;
      partes.push(encodeURIComponent(clave) + '=' + encodeURIComponent(valor));
    });
    return partes.length ? url + (url.indexOf('?') >= 0 ? '&' : '?') + partes.join('&') : url;
  }

  /**
   * Cliente HTTP central.
   * @param {string} path ruta relativa a CONFIG.API_BASE_URL
   * @param {Object} opciones method, body, params, signal, etag
   */
  function apiFetch(path, opciones) {
    opciones = opciones || {};
    if (!opciones.public && !sesionValida()) {
      irALogin('Tu sesión expiró. Ingresá nuevamente para continuar.');
      return Promise.reject(new ApiError(401, 'Sesión expirada.'));
    }

    var method = opciones.method || 'GET';
    var url = construirUrl(path, opciones.params);
    var clave = method + ' ' + url;
    if (opciones.dedupe !== false && requestsEnVuelo.has(clave)) {
      return requestsEnVuelo.get(clave);
    }

    var headers = opciones.public
      ? { 'Accept': 'application/json' }
      : getAuthHeaders();
    var body;
    if (opciones.body !== undefined && opciones.body !== null) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opciones.body);
    }
    if (opciones.etag && cacheEtag.has(url)) {
      headers['If-None-Match'] = cacheEtag.get(url).etag;
    }

    var promesa = fetch(url, {
      method: method,
      headers: headers,
      body: body,
      signal: opciones.signal || null,
      credentials: 'omit',
      cache: 'no-store'
    }).then(function (res) {
      if (res.status === 304 && opciones.etag && cacheEtag.has(url)) {
        return cacheEtag.get(url).data;
      }
      validarRespuestaProtegida(res, opciones);
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var detalle = (data && (data.detail || data.message)) ||
            'No se pudo completar la solicitud (' + res.status + ').';
          throw new ApiError(res.status, detalle, data);
        }
        var etag = res.headers.get('ETag');
        if (opciones.etag && etag) cacheEtag.set(url, { etag: etag, data: data });
        return data;
      });
    }).finally(function () {
      requestsEnVuelo.delete(clave);
    });

    requestsEnVuelo.set(clave, promesa);
    return promesa;
  }

  function get(path, opciones) {
    opciones = opciones || {};
    opciones.method = 'GET';
    return apiFetch(path, opciones);
  }
  function post(path, body, opciones) {
    return apiFetch(path, Object.assign({}, opciones, { method: 'POST', body: body }));
  }
  function put(path, body, opciones) {
    return apiFetch(path, Object.assign({}, opciones, { method: 'PUT', body: body }));
  }

  // 401/403 en cualquier petición protegida (JSON, FormData o descarga) debe
  // terminar siempre en el mismo re-login limpio.
  function validarRespuestaProtegida(res, opciones) {
    if ((res.status === 401 || res.status === 403) && !(opciones && opciones.public)) {
      var mensaje = res.status === 401
        ? 'Tu sesión expiró. Ingresá nuevamente.'
        : 'No tenés permiso para realizar esta acción.';
      irALogin(mensaje);
      throw new ApiError(res.status, mensaje);
    }
  }

  // Requests con FormData (importaciones de Excel/PDF): el navegador pone el
  // Content-Type con el boundary correcto, así que no se fuerza JSON.
  function enviarFormulario(path, formData, opciones) {
    opciones = opciones || {};
    if (!sesionValida()) {
      irALogin('Tu sesión expiró. Ingresá nuevamente para continuar.');
      return Promise.reject(new ApiError(401, 'Sesión expirada.'));
    }
    return fetch(construirUrl(path, opciones.params), {
      method: opciones.method || 'POST',
      headers: getAuthHeaders(),
      body: formData,
      signal: opciones.signal || null,
      cache: 'no-store'
    }).then(function (res) {
      validarRespuestaProtegida(res, opciones);
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var detalle = (data && (data.detail || data.message)) ||
            'No se pudo completar la carga (' + res.status + ').';
          throw new ApiError(res.status, detalle, data);
        }
        return data;
      });
    });
  }

  function controlador() {
    return new global.AbortController();
  }

  function debounce(fn, espera) {
    var timer;
    return function () {
      var ctx = this;
      var args = arguments;
      global.clearTimeout(timer);
      timer = global.setTimeout(function () { fn.apply(ctx, args); }, espera || 300);
    };
  }

  function mensajeDeError(err) {
    if (!err) return 'Error desconocido.';
    if (err.name === 'AbortError') return '';
    return err.detail || err.message || 'Error desconocido.';
  }

  function mostrarError(err, contenedor) {
    var texto = mensajeDeError(err);
    if (!texto) return;
    var destino = typeof contenedor === 'string'
      ? document.querySelector(contenedor)
      : contenedor;
    if (destino) destino.textContent = texto;
    else global.console.error(texto);
  }

  var promptInstalacion = null;

  function crearBotonInstalacion() {
    if (document.getElementById('btn-instalar-pwa')) return;
    var boton = document.createElement('button');
    boton.id = 'btn-instalar-pwa';
    boton.type = 'button';
    boton.textContent = '📲 Instalar app';
    boton.setAttribute('class', 'btn btn-sm btn-outline-light shadow-sm');
    boton.setAttribute('style', 'position:fixed;right:16px;bottom:16px;z-index:2000;');
    boton.addEventListener('click', function () {
      if (!promptInstalacion) return;
      promptInstalacion.prompt();
      promptInstalacion.userChoice.then(function () { promptInstalacion = null; });
      boton.remove();
    });
    document.body.appendChild(boton);
  }

  global.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    promptInstalacion = event;
    if (document.body) crearBotonInstalacion();
    else document.addEventListener('DOMContentLoaded', crearBotonInstalacion);
  });

  function registrarServiceWorker() {
    if (!('serviceWorker' in navigator)) return Promise.resolve();
    return navigator.serviceWorker.register('sw.js', { scope: './' })
      .catch(function (err) {
        global.console.warn('No se pudo registrar el service worker:', err);
      });
  }

  // Descarga archivos protegidos (PDF, Excel) sin perder el header Bearer.
  function descargarArchivo(path, nombre, opciones) {
    opciones = opciones || {};
    return fetch(construirUrl(path, opciones.params), {
      method: 'GET',
      headers: getAuthHeaders(),
      signal: opciones.signal || null,
      cache: 'no-store'
    }).then(function (res) {
      validarRespuestaProtegida(res, opciones);
      if (!res.ok) throw new ApiError(res.status, 'No se pudo descargar el archivo.');
      return res.blob();
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var enlace = document.createElement('a');
      enlace.href = url;
      enlace.download = nombre || 'descarga';
      document.body.appendChild(enlace);
      enlace.click();
      enlace.remove();
      URL.revokeObjectURL(url);
    });
  }

  function cargarScript(url, integrity, crossorigin) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = url;
      if (integrity) {
        script.integrity = integrity;
        script.crossOrigin = crossorigin || 'anonymous';
      }
      script.onload = resolve;
      script.onerror = function () { reject(new Error('No se pudo cargar ' + url)); };
      document.head.appendChild(script);
    });
  }

  global.API = {
    get: get,
    post: post,
    put: put,
    form: enviarFormulario,
    fetch: apiFetch,
    error: ApiError,
    controlador: controlador,
    debounce: debounce,
    mensajeDeError: mensajeDeError,
    mostrarError: mostrarError,
    descargarArchivo: descargarArchivo,
    cargarScript: cargarScript
  };

  global.Sesion = {
    guardar: guardarSesion,
    limpiar: limpiarSesion,
    verificar: verificarSesion,
    requerirRol: requerirRol,
    rol: restr,
    usuario: usuario,
    token: token,
    destinoPorRol: destinoPorRol,
    irALogin: irALogin
  };

  // Compatibilidad con el código existente que aún llama a estas globales.
  global.getAuthHeaders = getAuthHeaders;
  global.verificarSesion = verificarSesion;
  global.requerirRol = requerirRol;
  global.cerrarSesion = cerrarSesion;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', registrarServiceWorker);
  } else {
    registrarServiceWorker();
  }
})(window);
