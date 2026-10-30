# Processador de apostas — solução

`README.md` é o enunciado da Jungle Gaming e não foi reescrito. Este arquivo é o guia da implementação. As decisões fechadas estão em `ARCHITECTURE.md`. A matriz requisito a requisito está em `docs/conformidade.md`.

## O que está pronto

API HTTP, consumidor de `wager-transactions.fifo`, inbox, ledger, outbox, publisher, worker de `PENDING_REFERENCE` e a suíte com três ou mais processos Bun. PostgreSQL 16 e LocalStack 4.7 sobem pelo Docker Compose. O processo Nest roda no host.

Não há Identity Provider, dashboard, OpenTelemetry nem teste de carga. O `AuthGuard` das rotas financeiras é no-op, de propósito, e está documentado na decisão D2.

## Pré-requisitos

- Bun 1.x no `PATH`. A versão usada aqui foi 1.4.4.
- Docker com Compose.
- As portas 5432 e 4566 livres, ou a porta do Postgres ajustada no `.env`.

Não há dependência de caminho da máquina de desenvolvimento. Credenciais do exemplo são as do Compose local (`wager` / `wager`, chave AWS `test` / `test`). Não são segredos de produção. O arquivo `.env` não entra no Git.

## Configurar e subir

```bash
cp .env.example .env
bun install
docker compose up -d --wait
bun run migration:up
bun run queues:up
```

Se a porta 5432 estiver ocupada, altere juntos `POSTGRES_HOST_PORT`, `DATABASE_URL` e `DATABASE_APP_URL`. O default do Compose continua 5432. O LocalStack permanece em 4566. Se essa porta estiver ocupada, o Compose não sobe.

```bash
bun run start    # HTTP em PORT, default 3000
bun run worker   # consumidor, publisher e worker de referência
```

Migrations, na ordem: vazia reversível, papel `wager_app`, schema financeiro. `bun run migration:down` desfaz a última. O papel da aplicação não é dono das tabelas e não pode `TRUNCATE`.

Filas, com deduplicação por conteúdo desligada:

| Fila | Papel |
| --- | --- |
| `wager-transactions.fifo` | Comandos. Visibility 60 s. `maxReceiveCount` 5 para a DLQ. |
| `wager-transactions-dlq.fifo` | Payload inválido na primeira leitura, ou esgotamento do receive count. |
| `wager-domain-events.fifo` | Outbox. Sem DLQ de saída. `MessageGroupId` é a wallet. `MessageDeduplicationId` é o `eventId`. |

## HTTP

Health não exige autenticação.

```bash
curl -s http://127.0.0.1:3000/health/live
curl -s http://127.0.0.1:3000/health/ready
```

Abrir uma wallet:

```bash
curl -s -X POST http://127.0.0.1:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

O `id` devolvido entra na aposta. A chave de idempotência é obrigatória e tem de ser `{providerId}:{externalTransactionId}`. Amount é string.

```bash
curl -s -X POST http://127.0.0.1:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'idempotency-key: prov:bet-1' \
  -d '{
    "providerId": "prov",
    "externalTransactionId": "bet-1",
    "playerId": "player-1",
    "walletId": "COLE_O_ID",
    "roundId": "round-1",
    "gameId": "game-1",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

Consultas:

```bash
curl -s http://127.0.0.1:3000/wallets/COLE_O_ID
curl -s http://127.0.0.1:3000/wallets/COLE_O_ID/ledger
curl -s http://127.0.0.1:3000/wagering/transactions/COLE_O_TRANSACTION_ID
curl -s -X POST http://127.0.0.1:3000/wallets/COLE_O_ID/reconciliation -H 'content-type: application/json' -d '{}'
```

Repetir o POST com a mesma chave e o mesmo corpo devolve o saldo observado na primeira vez, não o saldo vivo. Outro valor na mesma chave responde 409 `IDEMPOTENCY_PAYLOAD_MISMATCH`. Duas apostas de `80.00` sobre `100.00` deixam uma processada, uma rejeitada por saldo, saldo `20.00` e um débito.

## SQS

Com a wallet criada e o worker no ar, publique em `wager-transactions.fifo`. O `walletId` da mensagem tem de ser o id devolvido pelo HTTP. `MessageGroupId` é a wallet.

```json
{
  "messageId": "msg-bet-1",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-29T15:00:00.000Z",
  "data": {
    "providerId": "prov",
    "externalTransactionId": "bet-sqs-1",
    "idempotencyKey": "prov:bet-sqs-1",
    "playerId": "player-1",
    "walletId": "COLE_O_ID",
    "roundId": "round-1",
    "gameId": "game-1",
    "kind": "BET",
    "money": { "amount": "10.00", "currency": "BRL" }
  }
}
```

A AWS CLI não é pré-requisito. O comando abaixo só serve para o envio manual. `bun run queues:up`, o worker e os testes publicam com o SDK, sem essa CLI.

```bash
aws --endpoint-url http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "COLE_O_ID" \
  --message-deduplication-id "bet-sqs-1" \
  --message-body file://mensagem.json
```

O worker usa o mesmo caso de uso do HTTP. A inbox, o saldo, o ledger e a outbox commitam juntos. O `DeleteMessage` só ocorre depois. Payload inválido vai à DLQ na primeira leitura, com uma linha em `ingress_rejects` e sem amount no log.

## Concorrência e idempotência

A unidade de concorrência é a wallet: `SELECT … FOR UPDATE` dessa linha, nunca da tabela. Outra wallet segue em paralelo. A unicidade da aposta está em `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`. A da inbox está em `(consumer_name, message_id)`. A da reversão está no índice parcial `ux_reversal_once`: no máximo uma reversão `PROCESSED` por transação referenciada, seja `REFUND` ou `ROLLBACK`. Essa leitura é a decisão D7, mais estreita que a regra 4 do enunciado, e está na lista de divergências de `ARCHITECTURE.md`.

O publisher só lê a outbox depois do commit. Vários publishers usam `FOR UPDATE SKIP LOCKED` e, dentro da wallet, só o evento não publicado mais antigo sai. `published_at` entra depois do `SendMessage`. A linha não é apagada. Reenvio usa o mesmo `eventId`.

O worker de referência reivindica a pendência, commita o lease sem travar a wallet e sem subir `attempt_count`, e só então abre outra transação que trava a wallet. Replay e redelivery não movem o prazo.

## Testes

```bash
bun test
bun run test:distributed
bun run lint
bun run build
```

`bun test` cobre unidade, schema, HTTP e a integração assíncrona dentro de um processo. Essa suíte trunca as tabelas financeiras deste banco. O arquivo `test/persistence.integration.test.ts`, que entra em `bun test`, desfaz as migrations até o zero e as aplica de novo, inclusive o papel `wager_app`. `bun run test:distributed` sobe processos Bun com PIDs distintos contra o mesmo banco e a mesma fila, e escuta nas portas 3471, 3472 e 3473. Ela trunca as mesmas tabelas e reinicia os containers `postgres` e `localstack` deste Compose. Não apaga volume e não mexe em outros projetos. Não rode nenhuma das duas em cima de dados que precisem sobreviver.

## Trade-offs

- Dinheiro é `decimal.js` e `numeric(20,2)`. Escala curta vira duas casas. `"brl"`, número JSON e `"0.00"` externo são `INVALID_PAYLOAD`.
- `FAILED` é só constraint desconhecida, numa transação nova, sem saldo, sem ledger e sem outbox. O replay é HTTP 500.
- A chave de idempotência é obrigatoriamente `providerId:externalTransactionId`.
- TTL da referência em operação: 15 min. No perfil de teste da suíte assíncrona os backoff são curtos; o `.env` de exemplo mantém 15 min.
- Métricas e o contador de divergência da reconciliação vivem no processo.
- O consumidor que persiste `eventId` está em `distributed/event-consumer-main.ts`. O processo `bun run worker` não consome `wager-domain-events.fifo`.

## Limitações

Estão classificadas em `docs/conformidade.md`. Resumo: o worker pode morrer com `57P03` durante o shutdown do Postgres; `ingress_rejects` pode duplicar linha de auditoria; `attempt_count` pode ser regravado sob lease vencido sem segundo crédito; a deduplicação de cinco minutos do FIFO não substitui `eventId` persistido; o LocalStack sem volume perde mensagem já enviada; o guard de autenticação não autentica.
