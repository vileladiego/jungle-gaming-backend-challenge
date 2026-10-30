# Ambiente

O enunciado está em `README.md`. As decisões estão em `ARCHITECTURE.md`. O passo a passo para um avaliador está em `SOLUTION.md`.

## Versões conferidas

| Peça | Versão |
| --- | --- |
| Bun | 1.4.4 |
| NestJS | 11 |
| TypeScript | 5 |
| MikroORM | 6 |
| PostgreSQL | 16.10 |
| LocalStack | 4.7.0 |

O avaliador precisa do Bun 1.x no `PATH`. A pasta `.tools/` é um atalho local, está no `.gitignore` e não faz parte da entrega.

## Subir

```bash
cp .env.example .env
bun install
docker compose up -d --wait
bun run migration:up
bun run queues:up
```

O Compose publica o Postgres em `POSTGRES_HOST_PORT` (5432 no exemplo). Se essa porta já estiver ocupada, troque a porta e as duas URLs no `.env` juntas. Não apague volumes de outros projetos.

```bash
bun run start
bun run worker
```

A API não sobe os workers. O worker não escuta HTTP.

## Testes

```bash
bun test
bun run test:distributed
bun run lint
bun run build
```

`bun test` não inclui a suíte distribuída. As duas suítes usam o Postgres e o LocalStack deste Compose e truncam as tabelas financeiras. Dentro de `bun test`, `test/persistence.integration.test.ts` também desfaz e reaplica as migrations. A distribuída escuta nas portas 3471, 3472 e 3473 e reinicia os containers `postgres` e `localstack`. O LocalStack do Compose fica na porta 4566. Não use nenhuma das suítes em um banco com dados que precisem ser preservados. A AWS CLI não é necessária: os testes e `bun run queues:up` falam com o LocalStack pelo SDK.
