import { Migration } from '@mikro-orm/migrations';

/**
 * Fase 1. Sobe e desce sem DDL de domínio.
 * O runner do MikroORM cria apenas a tabela de controle mikro_orm_migrations.
 */
export class Migration20261029143000_Empty extends Migration {
  override async up(): Promise<void> {
    this.addSql('select 1');
  }

  override async down(): Promise<void> {
    this.addSql('select 1');
  }
}
