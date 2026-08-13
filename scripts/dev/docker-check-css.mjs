import Database from 'better-sqlite3';
const db = new Database('/app/data/dexter.sqlite');

const project_id = '66e9734b-1353-4732-b506-f5e8f55b01f0';

const snapshot = db.prepare('SELECT files_json FROM snapshots WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(project_id);

if (snapshot) {
    const files = JSON.parse(snapshot.files_json);
    console.log(`Snapshot has ${files.length} files:`);
    for (const f of files) {
        console.log(`- ${f.name} (${f.language}) ${f.code.length} bytes`);
    }

    const packageJson = files.find(f => f.name === 'package.json');
    if (packageJson) {
        console.log('\n--- package.json ---');
        console.log(packageJson.code);
    }

    const indexCss = files.find(f => f.name === 'src/index.css');
    if (indexCss) {
        console.log('\n--- src/index.css ---');
        console.log(indexCss.code);
    }

    const mainJsx = files.find(f => f.name === 'src/main.jsx' || f.name === 'src/main.tsx');
    if (mainJsx) {
        console.log(`\n--- ${mainJsx.name} ---`);
        console.log(mainJsx.code);
    }
} else {
    console.log("No snapshot found for this project.");
}
