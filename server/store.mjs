import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export async function openStore(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, "roster.sqlite");
  const db = new DatabaseSync(filename);
  db.exec(
    "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
  );
  const all = (sql, args = []) => db.prepare(sql).all(...args);
  const one = (sql, args = []) => all(sql, args)[0];
  const run = (sql, args = []) => db.prepare(sql).run(...args);
  db.exec(
    `CREATE TABLE IF NOT EXISTS migration(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);`,
  );
  if (!one("SELECT * FROM migration WHERE version=1")) {
    db.exec(`BEGIN;
      CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',instructions TEXT NOT NULL DEFAULT '',color TEXT NOT NULL DEFAULT 'green',provider TEXT NOT NULL DEFAULT 'auto',workspace TEXT NOT NULL DEFAULT '',benched INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
      CREATE TABLE teams(id TEXT PRIMARY KEY,name TEXT NOT NULL,objective TEXT NOT NULL DEFAULT '',workspace TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
      CREATE TABLE team_members(team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,PRIMARY KEY(team_id,agent_id));
      CREATE TABLE conversations(id TEXT PRIMARY KEY,agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,name TEXT NOT NULL,pinned INTEGER DEFAULT 0,archived INTEGER DEFAULT 0,read_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,role TEXT NOT NULL,content TEXT NOT NULL DEFAULT '',kind TEXT NOT NULL DEFAULT 'text',status TEXT NOT NULL DEFAULT 'complete',reply_to TEXT REFERENCES messages(id),created_at TEXT NOT NULL);
      CREATE TABLE tasks(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),message_id TEXT REFERENCES messages(id),owner_id TEXT REFERENCES agents(id) ON DELETE SET NULL,title TEXT NOT NULL,objective TEXT NOT NULL,status TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'work',workspace TEXT NOT NULL DEFAULT '',result TEXT DEFAULT '',error TEXT DEFAULT '',verification TEXT NOT NULL DEFAULT 'unverified',created_at TEXT NOT NULL,started_at TEXT,completed_at TEXT);
      CREATE TABLE task_dependencies(task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,depends_on TEXT REFERENCES tasks(id) ON DELETE CASCADE,PRIMARY KEY(task_id,depends_on));
      CREATE TABLE events(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),type TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE approvals(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),title TEXT NOT NULL,detail TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL,resolved_at TEXT);
      CREATE TABLE memories(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE attachments(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),message_id TEXT REFERENCES messages(id),name TEXT NOT NULL,content TEXT NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE runtime_sessions(id TEXT PRIMARY KEY,agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,conversation_id TEXT REFERENCES conversations(id),provider TEXT NOT NULL,thread_id TEXT NOT NULL,workspace TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(agent_id,conversation_id,provider,workspace));
      CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO migration VALUES(1,datetime('now')); COMMIT;`);
  }
  if (!one("SELECT * FROM migration WHERE version=2")) {
    db.exec(`BEGIN;
      CREATE TABLE artifacts(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),name TEXT NOT NULL,content TEXT NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),content TEXT NOT NULL,through_rowid INTEGER NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX message_conversation ON messages(conversation_id,created_at);
      CREATE INDEX task_status ON tasks(status,created_at);
      CREATE INDEX task_conversation ON tasks(conversation_id,created_at);
      CREATE INDEX event_task ON events(task_id,created_at);
      CREATE INDEX attachment_message ON attachments(message_id);
      INSERT INTO migration VALUES(2,datetime('now')); COMMIT;`);
  }
  if (!one("SELECT * FROM migration WHERE version=3")) {
    db.exec(`BEGIN;
      CREATE TABLE task_instructions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,message_id TEXT REFERENCES messages(id),kind TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX task_instruction_task ON task_instructions(task_id,created_at);
      INSERT INTO migration VALUES(3,datetime('now')); COMMIT;`);
  }
  if (!one("SELECT * FROM migration WHERE version=4")) {
    db.exec(`BEGIN;
      ALTER TABLE agents ADD COLUMN permission_level TEXT NOT NULL DEFAULT 'standard';
      ALTER TABLE tasks ADD COLUMN intent_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE tasks ADD COLUMN requirements_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE tasks ADD COLUMN root_task_id TEXT;
      ALTER TABLE tasks ADD COLUMN repository TEXT NOT NULL DEFAULT '';
      ALTER TABLE tasks ADD COLUMN base_commit TEXT NOT NULL DEFAULT '';
      ALTER TABLE tasks ADD COLUMN branch TEXT NOT NULL DEFAULT '';
      ALTER TABLE tasks ADD COLUMN worktree_path TEXT NOT NULL DEFAULT '';
      CREATE TABLE outcome_contracts(id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,goal TEXT NOT NULL,constraints_json TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL DEFAULT 'planning',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE acceptance_criteria(id TEXT PRIMARY KEY,outcome_id TEXT NOT NULL REFERENCES outcome_contracts(id) ON DELETE CASCADE,type TEXT NOT NULL,description TEXT NOT NULL,command TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending',evidence_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE evidence(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,outcome_id TEXT REFERENCES outcome_contracts(id) ON DELETE CASCADE,type TEXT NOT NULL,source TEXT NOT NULL,status TEXT NOT NULL,summary TEXT NOT NULL,artifact_id TEXT,external_url TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
      CREATE TABLE review_verdicts(id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,verdict TEXT NOT NULL,summary TEXT NOT NULL,issues_json TEXT NOT NULL DEFAULT '[]',checks_json TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL);
      CREATE TABLE work_receipts(id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,outcome_id TEXT REFERENCES outcome_contracts(id) ON DELETE SET NULL,content TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE attention_items(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,type TEXT NOT NULL,title TEXT NOT NULL,detail TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',action_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,resolved_at TEXT);
      CREATE INDEX task_root ON tasks(root_task_id,created_at);
      CREATE INDEX evidence_task ON evidence(task_id,created_at);
      CREATE INDEX attention_open ON attention_items(status,created_at);
      INSERT INTO migration VALUES(4,datetime('now')); COMMIT;`);
  }
  if (!one("SELECT * FROM migration WHERE version=5")) {
    db.exec(`BEGIN;
      CREATE TABLE integrations(id TEXT PRIMARY KEY,provider TEXT NOT NULL UNIQUE,name TEXT NOT NULL,type TEXT NOT NULL,status TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',capabilities_json TEXT NOT NULL DEFAULT '[]',risk_policy_json TEXT NOT NULL DEFAULT '{}',workspace_scope_json TEXT NOT NULL DEFAULT '[]',updated_at TEXT NOT NULL);
      CREATE TABLE integration_tools(id TEXT PRIMARY KEY,integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,name TEXT NOT NULL,description TEXT NOT NULL,input_schema_json TEXT NOT NULL DEFAULT '{}',risk TEXT NOT NULL,required_permissions_json TEXT NOT NULL DEFAULT '[]',evidence_type TEXT NOT NULL DEFAULT '',UNIQUE(integration_id,name));
      CREATE INDEX integration_tool_integration ON integration_tools(integration_id);
      INSERT INTO migration VALUES(5,datetime('now')); COMMIT;`);
  }
  if (!one("SELECT * FROM migration WHERE version=6")) {
    db.exec(`BEGIN;
      CREATE TABLE message_reactions(id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,emoji TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(message_id,emoji));
      CREATE INDEX message_reaction_message ON message_reactions(message_id);
      INSERT INTO migration VALUES(6,datetime('now')); COMMIT;`);
  }
  if (!one("SELECT * FROM migration WHERE version=7")) {
    db.exec(`BEGIN;
      ALTER TABLE conversations ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
      INSERT INTO migration VALUES(7,datetime('now')); COMMIT;`);
  }
  if (!one("SELECT * FROM migration WHERE version=8")) {
    db.exec(`BEGIN;
      CREATE TABLE mcp_connections(id TEXT PRIMARY KEY,url TEXT NOT NULL UNIQUE,server_name TEXT NOT NULL,status TEXT NOT NULL,detail TEXT NOT NULL,protocol_version TEXT NOT NULL,capabilities_json TEXT NOT NULL DEFAULT '[]',auth_metadata_json TEXT NOT NULL DEFAULT '{}',discovered_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      INSERT INTO migration VALUES(8,datetime('now')); COMMIT;`);
  }
  if (!one("SELECT * FROM migration WHERE version=9")) {
    db.exec(`BEGIN;
      CREATE TABLE project_profiles(id TEXT PRIMARY KEY,workspace TEXT NOT NULL UNIQUE,name TEXT NOT NULL,suggestions_json TEXT NOT NULL DEFAULT '[]',instructions_json TEXT NOT NULL DEFAULT '[]',updated_at TEXT NOT NULL);
      INSERT INTO migration VALUES(9,datetime('now')); COMMIT;`);
  }
  if (!one("SELECT * FROM migration WHERE version=10")) {
    db.exec(`BEGIN;
      ALTER TABLE agents ADD COLUMN avatar_data TEXT NOT NULL DEFAULT '';
      INSERT INTO migration VALUES(10,datetime('now')); COMMIT;`);
  }
  const setting = (key, fallback = null) => {
    const row = one("SELECT value FROM settings WHERE key=?", [key]);
    return row ? JSON.parse(row.value) : fallback;
  };
  const setSetting = (key, value) =>
    run(
      "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [key, JSON.stringify(value)],
    );
  return {
    directory,
    filename,
    all,
    one,
    run,
    setting,
    setSetting,
    close() {
      db.close();
    },
    transaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
