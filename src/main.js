const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

async function main() {
    console.log('S3 Explorer initialized');
    
    try {
        await import('./app.js');
        console.log('App loaded successfully');
    } catch (err) {
        console.error('Failed to load app.js:', err);
        document.getElementById('app').innerHTML = `
            <div style="padding: 40px; text-align: center; color: #ff5555;">
                <h2>Error loading application</h2>
                <p>${err.message}</p>
                <pre style="text-align: left; background: #1a1a1a; padding: 16px; margin-top: 20px; overflow: auto;">${err.stack || ''}</pre>
            </div>
        `;
    }
}

main();
