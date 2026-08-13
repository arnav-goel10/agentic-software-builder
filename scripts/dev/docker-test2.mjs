import Database from 'better-sqlite3';
const db = new Database('/app/data/dexter.sqlite');

const steps = db.prepare('SELECT phase, title, payload_json FROM run_steps WHERE run_id = (SELECT id FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1) ORDER BY seq ASC')
    .all('24029993-55a3-421d-8c3e-214557ded87d');

for (const step of steps) {
    const payload = JSON.parse(step.payload_json);
    let str = JSON.stringify(payload);
    if (str.includes('index.html')) {
        console.log(`FOUND in phase: ${step.phase}, title: ${step.title}`);

        if (payload.operations) {
            const op = payload.operations.find(o => o.path === 'index.html');
            if (op) console.log(op);
        }
        if (payload.tasks) {
            // Check if any tasks mention it
            console.log("Tasks mentioned index.html");
        }
        if (payload.dbSchema) console.log("Schema mentioned");
    }
}
