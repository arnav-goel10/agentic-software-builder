import Database from 'better-sqlite3';
const projectId = process.argv[2];
const db = new Database('/app/data/dexter.sqlite');
const run = db.prepare('SELECT id FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(projectId);
const artifacts = db.prepare('SELECT kind, content_json FROM run_artifacts WHERE run_id = ?').all(run.id);

console.log("Artifact kinds:", artifacts.map(a => a.kind).join(", "));

let skeletonDag = artifacts.find(a => a.kind === 'skeleton_dag');
if (skeletonDag) console.log("skeleton_dag Object.keys:", Object.keys(JSON.parse(skeletonDag.content_json)));

let fillResult = artifacts.find(a => a.kind === 'fill_results');
if (fillResult) console.log("fill_results Object.keys:", Object.keys(JSON.parse(fillResult.content_json)));
