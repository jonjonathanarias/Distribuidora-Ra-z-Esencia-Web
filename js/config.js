const CONFIG = {
    // Endpoint de la API. En producción se puede override desde el service worker
    // o desde una variable global inyectada antes de cargar este archivo.
    API_BASE_URL: (typeof window !== 'undefined' && window.API_BASE_URL) ||
        'http://127.0.0.1:8000'
};
