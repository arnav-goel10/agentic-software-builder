const Database = require('better-sqlite3');
const db = new Database('./dexter-copy.sqlite');

const row = db.prepare('SELECT files_json FROM snapshots WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
    .get('24029993-55a3-421d-8c3e-214557ded87d');

if (!row) {
    console.log("No snapshot found");
    process.exit(0);
}

const files = JSON.parse(row.files_json);

for (const file of files) {
    if (file.name.includes('vite.config')) {
        console.log('--- ORIGINAL VITE CONFIG IN DB ---');
        console.log(file.code);

        let code = file.code;
        if (!/server:\s*\{/.test(code) && /defineConfig\(\{/.test(code)) {
            code = code.replace(/defineConfig\(\{/, "defineConfig({\n  server: { host: '0.0.0.0', allowedHosts: true },");
        } else if (/server:\s*\{/.test(code)) {
            if (!/host:/.test(code)) {
                code = code.replace(/server:\s*\{/, "server: {\n    host: '0.0.0.0',");
            } else if (/host:\s*(true|['"]localhost['"])/.test(code)) {
                code = code.replace(/host:\s*(true|['"]localhost['"])/g, "host: '0.0.0.0'");
            }
            if (!/allowedHosts:/.test(code)) {
                code = code.replace(/server:\s*\{/, "server: {\n    allowedHosts: true,");
            }
        }
        console.log('--- PATCHED VITE CONFIG EXPECTED ---');
        console.log(code);
    }
}
