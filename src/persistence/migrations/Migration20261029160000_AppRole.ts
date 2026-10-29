import { Migration } from '@mikro-orm/migrations';

/**
 * Papel de runtime. Não é dono das tabelas e não recebe TRUNCATE.
 * A migration não é transacional: CREATE ROLE e DROP ROLE recusam bloco transacional.
 * A senha é só do Postgres local do Compose.
 */
export class Migration20261029160000_AppRole extends Migration {
  override isTransactional(): boolean {
    return false;
  }

  override async up(): Promise<void> {
    const existing = await this.execute(
      `select rolname from pg_roles where rolname = 'wager_app'`,
    );
    if (!Array.isArray(existing) || existing.length === 0) {
      this.addSql(
        `create role wager_app login password 'wager_app' nosuperuser nocreatedb nocreaterole`,
      );
    }
    this.addSql(`grant usage on schema public to wager_app`);
    this.addSql(`
      do $$
      begin
        execute format('grant connect on database %I to wager_app', current_database());
      end
      $$
    `);
  }

  override async down(): Promise<void> {
    const existing = await this.execute(
      `select rolname from pg_roles where rolname = 'wager_app'`,
    );
    if (!Array.isArray(existing) || existing.length === 0) {
      return;
    }
    this.addSql(`revoke all privileges on all tables in schema public from wager_app`);
    this.addSql(`revoke all privileges on schema public from wager_app`);
    this.addSql(`
      do $$
      begin
        execute format('revoke all privileges on database %I from wager_app', current_database());
      end
      $$
    `);
    this.addSql(`drop role wager_app`);
  }
}
