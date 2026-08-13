import Database from 'better-sqlite3';
const db = new Database('/app/data/dexter.sqlite');

const project_id = '24029993-55a3-421d-8c3e-214557ded87d';

const runs = db.prepare('SELECT id, created_at FROM runs WHERE project_id = ? ORDER BY created_at ASC').all(project_id);
console.log(`Found ${runs.length} runs`);

for (const run of runs) {
    console.log(`\nRun: ${run.id}`);
    const steps = db.prepare('SELECT phase, title, payload_json FROM run_steps WHERE run_id = ? ORDER BY seq ASC').all(run.id);
    for (const step of steps) {
        let p = JSON.parse(step.payload_json);
        if (JSON.stringify(p).includes('index.html')) {
            console.log(`  Step mentions index.html: ${step.phase} - ${step.title}`);
        }
    }

    const snapshot = db.prepare('SELECT files_json FROM snapshots WHERE run_id = ? ORDER BY created_at DESC LIMIT 1').get(run.id);
    if (snapshot) {
        const files = JSON.parse(snapshot.files_json);
        const indexHtml = files.find(f => f.name === 'index.html');
        if (indexHtml) {
            console.log(`  SNAPSHOT HAS INDEX.HTML`);
        } else {
            console.log(`  SNAPSHOT IS MISSING INDEX.HTML`);
        }
    } else {
        console.log(`  NO SNAPSHOT FOR THIS RUN`);
    }
}
