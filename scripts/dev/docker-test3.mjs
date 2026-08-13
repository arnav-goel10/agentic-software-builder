import Database from 'better-sqlite3';
const db = new Database('/app/data/dexter.sqlite');

const project_id = '24029993-55a3-421d-8c3e-214557ded87d';

const run = db.prepare('SELECT id FROM runs WHERE project_id = ? ORDER BY created_at ASC LIMIT 1').get(project_id);
if (!run) process.exit(0);

const steps = db.prepare('SELECT phase, title, payload_json FROM run_steps WHERE run_id = ? ORDER BY seq ASC').all(run.id);

for (const step of steps) {
    if (step.phase === 'spec') {
        const p = JSON.parse(step.payload_json);
        console.log(JSON.stringify(p.starterTemplate, null, 2));
    }
}
