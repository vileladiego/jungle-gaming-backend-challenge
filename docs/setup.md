# Fase 1 — ambiente

Runtime, Postgres, LocalStack, filas, migration vazia e health. Money, Wallet, Ledger, apostas, Inbox e Outbox ficam para as fases seguintes.

O enunciado continua em `README.md`. As decisões continuam em `ARCHITECTURE.md`.

## Versões conferidas

| Peça | Versão |
| --- | --- |
| Bun | 1.4.4 |
| NestJS | 11.2.8 |
| TypeScript | 5.9.3 |
| MikroORM | 6.6.17 |
| PostgreSQL | 16.10 |
| LocalStack | 4.7.0 |

Nesta máquina o Bun não estava no `PATH`. Foi instalado em `.tools/` (ignorado pelo Git) com `npm install --prefix .tools bun@1`. Os comandos abaixo usam esse binário.

## Subir a infraestrutura

```bash
cp .env.example .env
export PATH="$PWD/.tools/node_modules/.bin:$PATH"
bun install
docker compose up -d --wait
```

`POSTGRES_HOST_PORT` vale `5432` no exemplo. Nesta máquina as portas 5432 e 5433 já estavam ocupadas por outros containers, então o `.env` local usa `5434` e a `DATABASE_URL` aponta para `localhost:5434`. O default do Compose continua 5432.

O processo Nest roda no host. Só Postgres e LocalStack estão no Compose.

## Banco e filas

```bash
bun run migration:up
bun run migration:down
bun run migration:up
bun run queues:up
```

A migration `Migration20261029143000_Empty` executa `select 1` na subida e na descida. O runner cria apenas `mikro_orm_migrations`. Os scripts chamam o CLI pelo Bun, para carregar o `.env` e o config TypeScript.

Depois da última `migration:up`, `psql` mostrou só esta relação:

| tabela | colunas |
| --- | --- |
| `mikro_orm_migrations` | `id` integer, `name` varchar, `executed_at` timestamptz |

Não há tabela financeira nem coluna `numeric`, `real` ou `double precision`.

`queues:up` garante, nesta ordem:

1. `wager-transactions-dlq.fifo` — FIFO, deduplicação por conteúdo desligada, sem redrive.
2. `wager-transactions.fifo` — FIFO, deduplicação por conteúdo desligada, visibility 60 s, redrive `maxReceiveCount` 5 para a DLQ.
3. `wager-domain-events.fifo` — FIFO, deduplicação por conteúdo desligada, sem DLQ.

## Aplicação

```bash
bun run start
```

- `GET /health/live` responde 200 `{"status":"ok"}` sem consultar Postgres nem SQS e sem autenticação.
- `GET /health/ready` responde 200 `{"status":"ok","postgres":"up","sqs":"up"}` quando os dois estão alcançáveis. O corpo não traz URL, ARN nem credencial.
- Se Postgres ou SQS não responde, o campo correspondente fica `down` e o HTTP é 503.

`AuthGuard` existe e não está registrado como guard global. Health permanece aberto. A identidade real do provedor continua adiada.

## Verificação executada

Com Postgres em `localhost:5434` e LocalStack em `localhost:4566`, os dois healthy:

```text
bunx tsc -p tsconfig.json --noEmit     # exit 0
bunx tsc -p tsconfig.build.json        # exit 0
bun run lint                           # exit 0
bun run build                          # exit 0
bun test                               # 7 pass, 0 fail
bun run migration:down                 # revertida
bun run migration:up                   # aplicada
bun run queues:up                      # exit 0
```

O teste de integração sobe e desce a migration vazia, confirma a ausência de tabela financeira, lê os atributos das três filas e chama os dois endpoints. O corpo observado foi:

```text
GET /health/live   200 {"status":"ok"}
GET /health/ready  200 {"status":"ok","postgres":"up","sqs":"up"}
```

O mesmo teste marca Postgres e SQS como `down` quando o endereço não responde. O corpo de ready não contém `postgresql://`, porta do LocalStack nem segredo.
