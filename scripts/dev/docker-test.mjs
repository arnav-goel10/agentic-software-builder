import Database from 'better-sqlite3';
const db = new Database('/app/data/dexter.sqlite');

const row = db.prepare('SELECT files_json FROM snapshots WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
    .get('24029993-55a3-421d-8c3e-214557ded87d');

const files = JSON.parse(row.files_json);
console.log("FILES IN SNAPSHOT:");
files.forEach(f => console.log(f.name));

const indexHtml = files.find(f => f.name === 'index.html');
if (!indexHtml) {
    console.log("INDEX.HTML IS MISSING!");
} else {
    console.log("--- INDEX.HTML CONTENT ---");
    console.log(indexHtml.code);
}
