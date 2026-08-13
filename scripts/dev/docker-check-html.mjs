import Database from 'better-sqlite3';

const projectId = process.argv[2];
if (!projectId) {
    console.error("Usage: node docker-check-html.mjs <projectId>");
    process.exit(1);
}

const db = new Database('/app/data/dexter.sqlite');

const snapshot = db.prepare('SELECT files_json FROM snapshots WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(projectId);

if (snapshot) {
    const files = JSON.parse(snapshot.files_json);
    console.log(`Snapshot for ${projectId} has ${files.length} files:`);
    for (const f of files) {
        console.log(`- ${f.name} (${f.language}) ${f.code.length} bytes`);
    }

    const indexHtml = files.find(f => f.name === 'index.html');
    if (indexHtml) {
        console.log('\n--- index.html ---');
        console.log(indexHtml.code);
    } else {
        console.log('\n--- MISSING index.html ---');
    }

    const mainJsx = files.find(f => f.name === 'src/main.jsx' || f.name === 'src/main.tsx');
    if (mainJsx) {
        console.log(`\n--- ${mainJsx.name} ---`);
        console.log(mainJsx.code);
    } else {
        console.log('\n--- MISSING main.jsx ---');
    }

    const appJsx = files.find(f => f.name === 'src/App.jsx' || f.name === 'src/App.tsx');
    if (appJsx) {
        console.log(`\n--- ${appJsx.name} ---`);
        console.log(appJsx.code);
    } else {
        console.log('\n--- MISSING App.jsx ---');
    }
} else {
    console.log("No snapshot found for this project.");
}
