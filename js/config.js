const CONFIG = {
    // Al probar localmente usás tu FastAPI local:
    //API_BASE_URL: 'http://127.0.0.1:8000'
    // Para cuando despliegues el backend a producción:
    // API_BASE_URL: 'https://api.tu-distribuidora.com'
    API_BASE_URL: 'http://0.0.0.0:8000'
};

function getAuthHeaders() {
    const token = localStorage.getItem('jwt_token');
    return {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
    };
}

// Guard de navegación para páginas protegidas
function verificarSesion() {
    const token = localStorage.getItem('jwt_token');
    if (!token) {
        window.location.href = 'index.html';
    }
}

// Cerrar sesión limpiando el almacenamiento local
function cerrarSesion() {
    localStorage.removeItem('jwt_token');
    window.location.href = 'index.html';
}