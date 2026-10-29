# Proposta de arquitetura — Distributed Wagering Processor

Status: **revisada, aguardando aprovação das divergências**. D1–D14 incorporam as condições da revisão de Tech Lead, Security Reviewer e QA. O registro das decisões, o schema desenhado e a lista de divergências estão em `ARCHITECTURE.md`.

Código de produção, instalação de dependências e execução de migrations continuam bloqueados. Nada neste arquivo é resultado de teste executado. O canvas do Cursor não faz parte do repositório.

Fonte de verdade do enunciado: `README.md`. Stack fechada: TypeScript strict, Bun 1.x, NestJS, MikroORM 6, PostgreSQL 16, AWS SQS via LocalStack, Docker Compose, migrations versionadas e reversíveis.

## Como ler este documento

- **Fato** é o que o README exige.
- **Decisão** é D1–D14, já reescritas. A implementação espera o sim das divergências listadas em `ARCHITECTURE.md`.
- Nada aqui foi executado.

## 1. Requisitos funcionais

| ID | Requisito | Origem |
|---|---|---|
| RF-01 | `POST /wallets` abre uma wallet por `playerId` + `currency` | §9 |
| RF-02 | Saldo inicial maior que zero gera `OPENING` e um `CREDIT` na mesma transação SQL. `version` nasce em 1 | §6.2, §9 |
| RF-03 | Segunda wallet do mesmo `playerId` + `currency` falha como conflito | §9 |
| RF-04 | `GET /wallets/:walletId`, ledger com cursor opaco, transação por id interno e por `providerId` + `externalTransactionId` | §9 |
| RF-05 | `POST /wagering/transactions` exige o header `Idempotency-Key` | §9 |
| RF-06 | `BET` debita. Saldo insuficiente rejeita. Um lançamento `DEBIT` | §7, §8 |
| RF-07 | `WIN` credita. Referência à `BET` da mesma rodada é opcional | §7 |
| RF-08 | `LOSS` registra o resultado, não move saldo e não gera ledger | §6.4, §7 |
| RF-09 | `REFUND` credita uma `BET` `PROCESSED`, valor integral, mesmo provider, player, wallet, moeda e rodada | §7 |
| RF-10 | `ROLLBACK` inverte uma `BET`, `WIN` ou `REFUND` `PROCESSED`, valor integral, mesmo escopo | §7 |
| RF-11 | Referência ausente persiste `PENDING_REFERENCE`. Worker com backoff. Esgotado o limite: `REJECTED` e evento | §7.1 |
| RF-12 | Repetir operação já processada devolve o resultado original, inclusive o saldo observado naquele momento | §7, §9 |
| RF-13 | A mesma idempotency key com payload diferente é conflito, não replay | §6.3, §9 |
| RF-14 | `OPENING` é interno. API e fila recusam esse kind | §6.3 |
| RF-15 | Reversão que produziria saldo negativo é rejeitada com `failureCode` distinto de aposta sem saldo e permanece auditável | §7 |
| RF-16 | `POST /wallets/:walletId/reconciliation` compara saldo materializado e saldo calculado pelo ledger. Divergência não é corrigida em silêncio: log, métrica e resposta | §9 |
| RF-17 | `GET /health/live` e `GET /health/ready` sem autenticação. Ready exige PostgreSQL e SQS alcançáveis | §2, §9 |
| RF-18 | O consumidor SQS reutiliza o use case HTTP, deduplica por inbox `(consumerName, messageId)` e dá ack somente após o commit | §10 |
| RF-19 | Erro de negócio é terminal e dá ack. Erro transitório retenta com backoff. Erro permanente vai à DLQ, com limite de tentativas | §10 |
| RF-20 | Em `SIGTERM`, a instância conclui a mensagem em andamento ou devolve a visibilidade | §10 |
| RF-21 | Transação, saldo, ledger, inbox (quando a entrada for SQS) e outbox são atômicos. Vários publishers. Crash depois do commit ainda publica. Publicação duplicada é segura | §6.5, §11 |
| RF-22 | Eventos mínimos: `WagerTransactionProcessed` (inclusive `LOSS`), `WagerTransactionRejected`, `WalletBalanceChanged` somente quando o saldo muda, `WagerTransactionPendingReference` | §11 |

### Regras de negócio que os testes precisam fixar

| Operação | Saldo | Ledger | Regra |
|---|---|---|---|
| `BET` | débito | 1 `DEBIT` | rejeitar se saldo insuficiente |
| `WIN` | crédito | 1 `CREDIT` | pode referenciar a `BET` da mesma rodada |
| `LOSS` | nenhum | nenhum | resultado sem movimento |
| `REFUND` | crédito | 1 `CREDIT` | reverte uma `BET` `PROCESSED`, valor integral |
| `ROLLBACK` | inverso da referência | 1 entrada invertida | reverte `BET`, `WIN` ou `REFUND` `PROCESSED`, valor integral |

Fatos adicionais do enunciado:

1. `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`.
2. A referência resolve por `(providerId, referenceExternalTransactionId)` e pertence ao mesmo provider, player, wallet, moeda e rodada.
3. `REFUND` só referencia `BET`. `ROLLBACK` referencia `BET`, `WIN` ou `REFUND`.
4. O valor de `REFUND` e `ROLLBACK` é igual ao valor da referência. Reversão parcial está fora de escopo.
5. `REJECTED` não altera saldo nem gera ledger.
6. `PROCESSED`, `REJECTED` e `FAILED` são terminais. Transição a partir deles é erro de programação.
7. `PENDING` nasce na criação. `PENDING_REFERENCE` espera a transação referenciada.
8. Entrega da fila é at-least-once. Duplicata, fora de ordem, corrida, morte do processo e indisponibilidade temporária de PostgreSQL e SQS fazem parte do contrato.
9. Invariante global: o sistema não duplica crédito, não duplica débito, não perde evento confirmado e não permite saldo negativo.
10. Invariante de todo teste: `wallet.balance` igual ao saldo reconstruído pelo ledger.

Decisão D7, registrada como divergência: a mesma transação referenciada admite no máximo uma reversão `PROCESSED`, somando `REFUND` e `ROLLBACK`. A regra 4 do README fala em “pelo mesmo tipo”. O aperto evita dois créditos da mesma `BET`.

### Cenário obrigatório de concorrência

Saldo inicial `100.00 BRL`. Duas apostas de `80.00 BRL` ao mesmo tempo.

Resultado esperado:

- exatamente uma aposta `PROCESSED`;
- a outra `REJECTED` por saldo insuficiente (`INSUFFICIENT_FUNDS`);
- saldo final `20.00 BRL`;
- exatamente um lançamento de débito;
- nenhum retry duplica o débito.

## 2. Requisitos não funcionais

| ID | Requisito | Origem |
|---|---|---|
| RNF-01 | Bun 1.x, TypeScript strict, NestJS, PostgreSQL, SQS via LocalStack ou MiniStack, Docker Compose | §4 |
| RNF-02 | Migrations versionadas e reversíveis | §4 |
| RNF-03 | Correto com mensagem duplicada, fora de ordem, processamento simultâneo e três ou mais instâncias | §1, §3, §8 |
| RNF-04 | Logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` | §12 |
| RNF-05 | Log sem payload financeiro completo e sem dado sensível | §12 |
| RNF-06 | Métricas mínimas: transações por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag, latência de processamento | §12 |
| RNF-07 | Dinheiro recebido e serializado como string decimal com escala 2. Domínio independente de tipos do ORM e de decorators do NestJS | §6.1 |
| RNF-08 | Construtor privado ou protegido. Factories `create`, `from` e `rehydrate`. `rehydrate` não revalida transição | §6.0 |
| RNF-09 | Unicidade, imutabilidade e não-negatividade aplicadas no schema, não só na aplicação | §5 |
| RNF-10 | Recursos de ordenação e deduplicação do broker são otimização. O banco mantém as invariantes | §5, §8 |
| RNF-11 | Testes de integração usam PostgreSQL e LocalStack reais. Mock total de banco e fila é eliminatório | §13, §14 |
| RNF-12 | Observabilidade obrigatória: logs, métricas e health separado de liveness e readiness. OpenTelemetry e dashboard são opcionais | §12 |
| RNF-13 | Documentação de setup no `README.md` do projeto e decisões em `ARCHITECTURE.md` | §14 |
| RNF-14 | Autenticação não pontua. Implementar significa IdP externo. Omitir é aceito se o desenho e o ponto de extensão ficarem documentados | §2 |

ORM: MikroORM é a opção preferencial do README. Prisma está fora.

## 3. Restrições invioláveis e falhas eliminatórias

| ID | Restrição |
|---|---|
| C-01 | Sem `number`, `float` ou `double` para dinheiro |
| C-02 | Sem cache em memória como garantia de idempotência |
| C-03 | SQS FIFO sozinho não fecha consistência |
| C-04 | Nenhum evento publicado antes do commit financeiro |
| C-05 | Ledger sem sobrescrita e sem exclusão |
| C-06 | Sem lock global compartilhado por todas as wallets |
| C-07 | Sem saldo no ciclo read, calculate, update sem controle de concorrência |
| C-08 | A solução precisa estar correta com múltiplas instâncias |
| C-09 | Débito duplicado, crédito duplicado, saldo negativo por corrida ou ledger ausente eliminam a entrega |

## 4. Decisões

Cada item abaixo já inclui as condições da revisão. O sim pendente é o das divergências em `ARCHITECTURE.md`, não uma nova rodada de desenho.

| ID | Escolha | Condição incorporada |
|---|---|---|
| D1 | MikroORM 6. Domínio separado da entidade. Repositório é o único escritor. `rehydrate` recebe string e só então chama `Money`. Versionamento automático do ORM desligado | Fase 1 prova Bun, Nest, MikroORM 6 e `pg` antes da migration de dinheiro |
| D2 | Autenticação adiada: `ProviderIdentityPort` e `AuthGuard` no-op nas rotas que movem dinheiro ou consultam. Health aberto. IdP previsto: Keycloak ou Zitadel | `providerId` segue validação de domínio nos dois canais. Prefixo `internal` é reservado. Exposição residual documentada |
| D3 | Cenários principais em `BRL`. Qualquer moeda `^[A-Z]{3}$` abre wallet. `Money` continua multi-moeda | O teste de conflito usa uma segunda moeda real, no agregado e no banco |
| D4 | `decimal.js` com precisão 40. Validação lexical antes de qualquer conversão. Escala 2 por preenchimento, sem arredondamento. Coluna `numeric(20,2)`. Moeda `varchar(3)`. Ida e volta sempre `string` | Proibidos `toNumber`, `Number`, `parseFloat` e parser numérico do OID 1700. Overflow é `AMOUNT_OVERFLOW` |
| D5 | `FOR UPDATE` por `walletId`. `version` sobe só quando o saldo muda. `LOSS` trava a wallet e não dá `UPDATE` na linha. `UPDATE` de saldo leva `WHERE id AND version` | `SKIP LOCKED` não é usado na wallet. `lock_timeout` 3s é transitório. Visibility da fila é 60s |
| D6 | `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)`, SHA-256 do JSON canônico, snapshot do saldo | Key obrigatória no formato `{providerId}:{externalTransactionId}`. Unique de payload idêntico vira replay depois de reler. Replay não grava segunda outbox |
| D7 | No máximo uma reversão `PROCESSED` por `reference_transaction_id`, qualquer kind. Índice `ux_reversal_once` | Corrida mapeada para `REFERENCE_ALREADY_REVERSED` numa transação nova. `CHECK` exige a referência interna quando `PROCESSED`. `ROLLBACK` de `REFUND` não devolve a vaga da `BET` |
| D8 | Ledger append-only: trigger recusa `UPDATE` e `DELETE`, `CHECK` aritmético, `UNIQUE (transaction_id)`, moeda no lançamento | Amount externo `"0.00"` é `INVALID_PAYLOAD`. Unique de lançamento repetido segue o remapeamento da D6. Trigger da transação de aposta ainda permite a ida ao estado terminal |
| D9 | Uma transação SQL para wallet, ledger, inbox e outbox. Ack e publish só depois do commit. Ordem: lock da wallet, idempotência, regra, ledger, saldo, outbox | `consumer_name` constante. Inbox com hash diferente não recebe ack de sucesso. 503 não grava `FAILED`. `SendMessage` fica fora da transação |
| D10 | Outbox em `wager-domain-events.fifo`. `FOR UPDATE SKIP LOCKED`. Por wallet, só o evento pendente mais antigo. Lease commitado antes do envio. `published_at` depois do sucesso. Sem DLQ de saída | `MessageDeduplicationId = eventId`. A dedup de 5 minutos do FIFO não é a garantia. `attempts` da outbox não contam referência pendente |
| D11 | `attempt_count`, `next_attempt_at` e `deadline_at` na transação. Backoff `min(teto, base * 2^(n-1))`. TTL operacional 15 min. Claim com `FOR UPDATE SKIP LOCKED` e depois lock da wallet | Replay e redelivery não incrementam tentativa. Referência terminal que não está `PROCESSED` rejeita na hora. 3s de TTL só no perfil de teste |
| D12 | 400, 409, 422, 202, 200, 503 e 500, com `failureCode` estável | 500 é replay de `FAILED`. 503 só quando nada foi commitado. 202 devolve o snapshot gravado. 409 traz `failureCode` e não o corpo de sucesso |
| D13 | LocalStack e PostgreSQL 16 com imagem pinada. Adapter Express. Três ou mais processos Bun no teste de corrida | A carga é aposta, reversão e outbox no mesmo banco e na mesma fila. Sem mock de PostgreSQL nem de SQS |
| D14 | `FAILED` permanece no modelo, sem evento novo. Constraint conhecida não vira `PERSISTENT_STATE_CORRUPT`. Payload inválido na fila grava `ingress_rejects` e vai à DLQ na primeira leitura | `SubmitWager` aceita só `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`. `OPENING` nasce em `OpenWallet` |

### D4 — forma canônica

Regex de `amount`, aplicada à string JSON, antes de `Decimal`:

```text
^(0|[1-9]\d{0,17})(\.\d{1,2})?$
```

`"25"` e `"25.0"` preenchem para `"25.00"`. `"0"` e `"0.0"` preenchem para `"0.00"` e, nos kinds externos, são `INVALID_PAYLOAD`. `"25.000"`, `"1e1"`, `"NaN"`, sinal, vazio e `"025.00"` são `INVALID_PAYLOAD`. Número JSON é `INVALID_PAYLOAD`. Moeda `^[A-Z]{3}$`. `"brl"` é `INVALID_PAYLOAD`. `numeric(20,2)` arredonda escala excedente no PostgreSQL; a regex é a barreira, e soma que não cabe na precisão vira `AMOUNT_OVERFLOW`.

A string canônica é a do hash, da coluna `numeric(20,2)` e da resposta. O tipo do MikroORM recusa `number`. O teste de ida e volta compara `"9007199254740993.99"` como string.

### D7 — índice e corrida

```sql
CREATE UNIQUE INDEX ux_reversal_once
  ON wager_transactions (reference_transaction_id)
  WHERE status = 'PROCESSED'
    AND kind IN ('REFUND', 'ROLLBACK');
```

`REJECTED` não ocupa a vaga. Unique violation desse índice aborta a transação. A transação seguinte, com `FOR UPDATE` da wallet, grava `REJECTED`, `REFERENCE_ALREADY_REVERSED` e `WagerTransactionRejected`. O ramo `PERSISTENT_STATE_CORRUPT` não trata `ux_reversal_once`.

Cadeia `BET` → `REFUND` → `ROLLBACK` do `REFUND` → segundo `REFUND` da `BET`: o segundo `REFUND` é `REFERENCE_ALREADY_REVERSED`. No exemplo 100 e 25, o saldo fica `75.00`. `ROLLBACK` de uma `WIN` e `REFUND` da `BET` usam referências diferentes e os dois podem ficar `PROCESSED`.

### D11 — relógio persistido

Na inserção de `PENDING_REFERENCE`: `attempt_count = 0`, `next_attempt_at = now()` do PostgreSQL, `deadline_at = now() + ttl`. A submissão não conta tentativa. O ack da mensagem de comando ocorre nesse commit.

| Parâmetro | Operação | Teste |
|---|---|---|
| Visibility timeout | 60s | 60s |
| `maxReceiveCount` | 5 | 5 |
| TTL | 15 min | 3s |
| Lease do claim | 30s | 100ms |
| Tentativas do worker | 8 | 3 |
| Base do backoff | 1s | 50ms |
| Teto do backoff | 30s | 200ms |
| Poll | 1s | 50ms |

`delay(n) = min(teto, base * 2^(n-1))`, com `n` igual ao `attempt_count` depois do incremento. O claim usa `FOR UPDATE SKIP LOCKED` e empurra um lease em `next_attempt_at` sem incrementar o contador. A resolução toma `FOR UPDATE` da wallet e relê. O contador sobe só se a linha continua `PENDING_REFERENCE`.

Referência inexistente com tentativas ou prazo esgotados: `REFERENCE_NOT_FOUND`. Referência `REJECTED` ou `FAILED`: `REFERENCE_NOT_PROCESSED` na hora. Referência existente e ainda não terminal, com limite esgotado: `REFERENCE_NOT_PROCESSED`.

### D12 — mapa HTTP

| Situação | HTTP | Corpo |
|---|---|---|
| Payload inválido, antes de persistir | 400 | `INVALID_PAYLOAD` ou `REFERENCE_REQUIRED` |
| Wallet duplicada | 409 | `WALLET_ALREADY_EXISTS` |
| Mesma key, outro hash | 409 | `IDEMPOTENCY_PAYLOAD_MISMATCH` |
| Par provider + external preso a outra key | 409 | `IDEMPOTENCY_KEY_MISMATCH` |
| Regra de negócio persistida como `REJECTED` | 422 | `transactionId`, `failureCode`, saldo observado quando a wallet existia |
| Wallet inexistente | 422 | `WALLET_NOT_FOUND`, sem campo de saldo |
| Referência ainda ausente | 202 | `PENDING_REFERENCE` e o snapshot da aceitação |
| Aplicada, inclusive replay | 200 | `idempotentReplay` true ou false |
| Nada commitado | 503 | sem status terminal |
| `FAILED` já commitado, inclusive replay | 500 | `PERSISTENT_STATE_CORRUPT` |
| Consulta inexistente | 404 | sem efeito financeiro |
| Abertura de wallet | 201 | conflito de player + moeda continua 409 |

A taxonomia completa está em `ARCHITECTURE.md`.

## 5. Arquitetura

```text
HTTP  ──┐
        ├── SubmitWager ── transação SQL ── commit ── ack / resposta
SQS   ──┘                      │
                               ├── wallets
                               ├── wager_transactions
                               ├── wallet_ledger_entries
                               ├── inbox_messages
                               ├── outbox_messages
                               └── ingress_rejects   (só poison de fila, sem efeito)
                                        │
                                        └── publisher ── wager-domain-events.fifo
```

`OpenWallet` não passa por `SubmitWager`.

| Camada | Responsabilidade |
|---|---|
| Domínio | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, família `IntegrationEvent`. Sem NestJS e sem MikroORM |
| Aplicação | `OpenWallet`, `SubmitWager`, `ReconcileWallet`, worker de referência e consultas. HTTP e SQS chamam o mesmo `SubmitWager` |
| Persistência | Entidades MikroORM, migrations `up`/`down`, tipo que reidrata `numeric` como string |
| Mensageria | Consumidor de `wager-transactions.fifo`, publisher da outbox, DLQ |

### Filas

| Fila | Papel |
|---|---|
| `wager-transactions.fifo` | Entrada. `MessageGroupId = walletId`. Visibility 60s. `maxReceiveCount = 5` |
| `wager-transactions-dlq.fifo` | Poison e falha permanente de transporte |
| `wager-domain-events.fifo` | Saída da outbox. `MessageGroupId = walletId`. `MessageDeduplicationId = eventId`. Sem DLQ de saída |

`consumer_name` do inbox é a constante `wager-transactions`.

### Hash canônico

SHA-256 hex minúsculo de JSON UTF-8 com chaves ordenadas em todos os níveis, sem espaço insignificante. Amount e moeda já canônicos, como em D4. `referenceExternalTransactionId` entra só quando o campo está presente e não é vazio. `null` e string vazia são `INVALID_PAYLOAD`. Ficam de fora o header, `messageId` e `occurredAt`.

### Idempotência entre HTTP e fila

1. A key tem de ser `{providerId}:{externalTransactionId}`.
2. Key encontrada e hash igual: snapshot persistido. Sem segunda outbox.
3. Key encontrada e hash diferente: 409 `IDEMPOTENCY_PAYLOAD_MISMATCH`.
4. Key nova e o par já existe: 409 `IDEMPOTENCY_KEY_MISMATCH`.
5. Os dois ausentes: processa, de novo depois do lock da wallet.

Unique violation de requisições iguais aborta a transação. A seguinte relê e responde replay se o hash bater.

### Ordem dentro da transação SQL

Isolamento `READ COMMITTED`. `lock_timeout` 3s. `statement_timeout` 5s.

1. `SELECT` da wallet `FOR UPDATE` quando a linha existe. Um segundo `SELECT` se o primeiro não achou.
2. Resolver idempotência e inbox.
3. Aplicar a regra de domínio.
4. Inserir o ledger se a operação altera saldo e foi aceita.
5. Atualizar saldo e `version` somente se o saldo mudou, com `WHERE id AND version`.
6. Persistir status, `failure_code` e snapshot.
7. Inserir a outbox.
8. Commit.
9. Só então responder HTTP ou dar ack.

Wallet que continua ausente persiste `WALLET_NOT_FOUND` sem ledger e sem saldo observado. Não há FK de `wallet_id`.

### Máquina de estados

```text
PENDING ──────────────► PROCESSED
   │                 └─► REJECTED
   │                 └─► FAILED
   └─► PENDING_REFERENCE ─► PROCESSED
                         └─► REJECTED
                         └─► FAILED
```

`PROCESSED`, `REJECTED` e `FAILED` não saem do estado. `FAILED` no runtime: a transação que estourou uma constraint não mapeada já sofreu rollback; uma transação nova grava `FAILED` / `PERSISTENT_STATE_CORRUPT`, sem saldo e sem ledger.

### version e saldo inicial

- Saldo inicial zero: `version = 1`, sem `OPENING`, sem ledger.
- Saldo inicial positivo: `OPENING` + `CREDIT` na mesma transação, `balanceBefore = 0.00`, `version` permanece 1.
- `BET`, `WIN`, `REFUND` e `ROLLBACK` que alteram o saldo sobem `version`.
- `LOSS` e `REJECTED` não sobem `version`. `LOSS` ainda toma `FOR UPDATE` para gravar o snapshot.

### Referências

| Kind | Referência |
|---|---|
| `BET` | ausente. Presença é `INVALID_PAYLOAD` |
| `WIN` | opcional, somente `BET` `PROCESSED` do mesmo escopo. Campo omitido processa na hora. Campo informado e ainda ausente: `PENDING_REFERENCE` |
| `LOSS` | ausente. Presença é `INVALID_PAYLOAD` |
| `REFUND` | obrigatória, somente `BET` `PROCESSED` |
| `ROLLBACK` | obrigatória, `BET`, `WIN` ou `REFUND` `PROCESSED` |
| `OPENING` | somente `OpenWallet`, key com prefixo `internal:` |

`ROLLBACK` de `BET` gera `CREDIT`. `ROLLBACK` de `WIN` ou `REFUND` gera `DEBIT`. Débito que deixaria saldo negativo usa `REVERSAL_INSUFFICIENT_FUNDS`.

### Eventos

Envelope abstrato `IntegrationEvent<T>`, uma subclasse por evento, `eventType` e `version` no tipo. `data` carrega `MoneyProps`.

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | transação aplicada, inclusive `LOSS` |
| `WagerTransactionRejected` | rejeição de negócio, inclusive prazo de referência e `REFERENCE_ALREADY_REVERSED` |
| `WalletBalanceChanged` | somente quando o saldo muda |
| `WagerTransactionPendingReference` | no momento em que a linha é persistida nesse status |

### Schema proposto

Desenho. A migration correspondente não foi criada nem executada. O detalhe de `CHECK`, trigger e ordem de `down` está em `ARCHITECTURE.md`.

`wallets`: PK, `UNIQUE (player_id, currency)`, `balance_amount numeric(20,2) CHECK (>= 0)`, moedas `varchar(3)` com `CHECK` lexical e iguais entre si, `version CHECK (>= 1)`.

`wager_transactions`: PK, uniques de key e de `(provider_id, external_transaction_id)`, `amount numeric(20,2) CHECK (> 0)`, moeda `varchar(3)`, `wallet_id` sem FK, snapshot nulo só sem wallet, `attempt_count`, `next_attempt_at`, `deadline_at`, `ux_reversal_once`, `CHECK` da referência interna em reversão `PROCESSED`, trigger que congela a linha no estado terminal.

`wallet_ledger_entries`: PK, `UNIQUE (transaction_id)`, `amount CHECK (> 0)`, `CHECK` aritmético, `CHECK (balance_after >= 0)`, moeda no lançamento, sem `updated_at`, trigger que recusa `UPDATE` e `DELETE`.

`inbox_messages`: PK `(consumer_name, message_id)`.

`outbox_messages`: PK = `eventId`, índice parcial das pendências.

`ingress_rejects`: trilha de poison sem amount e sem corpo.

Cursor do ledger: keyset opaco e assinado sobre `(created_at, id)`, sempre filtrado por `wallet_id`, parâmetros bind.

### Outbox, shutdown e observabilidade

Publishers concorrentes fazem `FOR UPDATE SKIP LOCKED`. Dentro da wallet, só o pendente mais antigo sai. Lease commitado antes do `SendMessage`. Backoff de publicação com teto de 60s. Evento commitado não vai para DLQ de saída.

`SIGTERM` espera o handler. Sem commit, a visibilidade volta para outra instância.

Logs JSON com os ids de correlação, sem amount, sem corpo de aposta, sem corpo de SQS e sem parâmetro de SQL. Métricas mínimas do §12. Live e ready separados. Ready não devolve credencial.

### Fora desta entrega

Partidas dobradas, OpenTelemetry, dashboard, Identity Provider real e teste de carga. Carga posterior entra como `bun run test:load`.

## 6. Matriz de testes

Todo teste de integração e de concorrência termina com a cadeia do ledger íntegra: cada lançamento fecha `balance_before ± amount = balance_after`, o último `balance_after` é o saldo da wallet, e a ausência de lançamento mantém o saldo inicial. `LOSS` e `REJECTED` não criam linha. PostgreSQL e LocalStack são reais. Os testes de unidade da fase 2 foram executados. Integração e concorrência da matriz abaixo continuam por executar.

O perfil de teste de D11 encurta TTL, tentativas e backoff. O default operacional permanece o da tabela de D11.

### Unidade

| ID | Requisito | Decisão | Assert |
|---|---|---|---|
| `TU-MONEY-SCALE` | §6.1, §13 | D4 | `"25.00"` aceito. `add`, `subtract` e `negate` devolvem outra instância. Serialização com duas casas. Moedas diferentes falham |
| `TU-MONEY-INVALID` | §6.1, §13 | D4 | `""`, `"NaN"`, `"Infinity"`, `"1e1"`, `"25.000"`, sinal e `"0.00"` são recusados antes de `Decimal`. Número JSON é `INVALID_PAYLOAD` |
| `TU-MONEY-SHORT-SCALE` | §6.1 | D4 | `"25"` e `"25.0"` viram `"25.00"` e produzem o mesmo hash |
| `TU-MONEY-CURRENCY-CASE` | §6.1 | D3, D4 | `"brl"` é `INVALID_PAYLOAD`. `"BRL"` é aceito. `"EUR"` abre wallet e conflita com operação em `"BRL"` |
| `TU-HASH` | §9, §13 | D4, D6 | SHA-256 estável com chaves ordenadas. Header, `messageId` e `occurredAt` ficam de fora. `"25"` e `"25.00"` têm o mesmo hash |
| `TU-WALLET` | §6.2, §13 | D5 | `version` nasce em 1 e só sobe quando o saldo muda. Saldo negativo é recusado no agregado |
| `TU-REHYDRATE` | §6.0 | D1 | `rehydrate` reconstrói estado terminal sem reaplicar regra de transição |
| `TU-RULES-FLOW` | §7, §13 | D5 | `BET` debita. `WIN` credita. `LOSS` não move saldo, não gera ledger e não sobe `version` |
| `TU-RULES-REVERSAL` | §7 | D7 | `REFUND` só sobre `BET`. `ROLLBACK` sobre `BET`, `WIN` ou `REFUND`. Valor igual. Direção invertida. Overdraft de reversão tem código distinto |
| `TU-REVERSAL-SLOT` | §7 regra 4 | D7 | Dois `REFUND`, dois `ROLLBACK` e `REFUND`+`ROLLBACK` da mesma `BET` rejeitam o segundo. `REJECTED` não ocupa a vaga. A cadeia com `ROLLBACK(REFUND)` mantém a vaga ocupada |
| `TU-CURRENCY` | §6.1, §13 | D3 | Operação entre moedas diferentes é erro de domínio |
| `TU-IDEMPOTENCY` | §6.3, §9, §13 | D6 | Mesmo hash é replay. Hash diferente é conflito, sem segundo efeito |
| `TU-STATE` | §6.3 | D14 | `PROCESSED`, `REJECTED` e `FAILED` não saem do estado |
| `TU-EVENTS` | §11 | D14 | `eventType` e `version` no tipo. `data` carrega string decimal. Não existe evento de `FAILED` |

### Integração

| ID | Requisito | Decisão | Assert |
|---|---|---|---|
| `TI-SCHEMA` | §4, §5.9, §13 | D4, D8 | `up` e `down`. `CHECK` de não-negatividade e da aritmética. Uniques. `UPDATE` e `DELETE` no ledger falham e a linha permanece. Coluna de valor é `numeric`, moeda é `varchar(3)` |
| `TI-MONEY-DRIVER` | §5.1, §6.1 | D4 | Driver e MikroORM devolvem `typeof string`. Round-trip de `"25.00"` e de `"9007199254740993.99"` |
| `TI-ATOMIC` | §6.5, §11, §13 | D9 | Falha forçada no `CHECK` do ledger desfaz wallet, inbox e outbox. HTTP não grava inbox. Nada aparece na fila de domínio antes do commit |
| `TI-INBOX` | §10, §13 | D6, D9 | Redelivery do mesmo `(consumer, messageId)` e mesmo hash não aplica de novo. Hash diferente vai à DLQ, grava `ingress_rejects` e não lança |
| `TI-HTTP-SQS-SAME-EFFECT` | §10 | D6, D9 | A mesma key pelos dois canais produz um débito e um replay |
| `TI-REPLAY-SNAPSHOT` | §7 regra 7, §9 | D6, D12 | Depois de outra movimentação, o replay devolve o saldo gravado na primeira resposta |
| `TI-IDEMPOTENCY-KEY-MISMATCH` | §9 | D6, D12 | Par provider + external já preso a outra key responde 409 e não lança |
| `TI-OUTBOX` | §11, §13 | D10 | Uma linha pendente, um `published_at`, um `eventId`. Sequencial, para não repetir `TC-6` |
| `TI-OUTBOX-DURABLE` | §11 | D10 | Falha de publish reagenda. O evento commitado não é apagado nem vai para DLQ de saída |
| `TI-DLQ` | §10, §13 | D14 | Negócio terminal dá ack e não vai à DLQ. Transitório retenta. Permanente de transporte cai na DLQ no `maxReceiveCount` |
| `TI-DLQ-INVALID` | §10, §6.3 | D14 | Payload inválido e `OPENING` externo não criam ledger. A DLQ recebe na primeira leitura, com linha em `ingress_rejects` |
| `TI-FAILED-NO-EVENT` | §6.3 | D14 | `PERSISTENT_STATE_CORRUPT` fica consultável, responde 500 e não publica evento. O gatilho não é `ux_reversal_once` nem unique de idempotência |
| `TI-WALLET-HTTP` | §9 | D5, D12 | Saldo positivo: `OPENING` + `CREDIT` + `version` 1. Saldo zero: `version` 1, sem ledger. Segunda wallet: 409 `WALLET_ALREADY_EXISTS` |
| `TI-OPENING-REJECTED` | §6.3 | D12, D14 | `OPENING` na API é 400 sem linha financeira. Na fila, o mesmo payload não lança |
| `TI-QUERIES` | §9 | D6 | Cursor opaco estável. Busca por id interno e por provider + external. Cursor de outra wallet não lê o ledger |
| `TI-HTTP-MAP` | §9 | D12 | 400, 409, 422, 202, 200, 503, 500 e 404 não colapsam. Replay de rejeição repete 422. Replay pendente repete 202 e, no terminal, passa a devolver esse terminal |
| `TI-REF-RULES` | §7 | D7, D12 | Escopo divergente, kind inválido, valor diferente e referência não `PROCESSED` rejeitam sem ledger, cada um com o seu `failureCode` |
| `TI-SINGLE-REVERSAL` | §7 regra 4 | D7 | Segundo estorno da mesma referência, inclusive outro kind, é `REFERENCE_ALREADY_REVERSED`, com um crédito só |
| `TI-REVERSAL-REJECTED-FREE` | §7, D7 | D7 | Estorno `REJECTED` não ocupa a vaga. O seguinte válido fica `PROCESSED` |
| `TI-REVERSAL-CHAIN` | §7 | D7 | `BET` → `REFUND` → `ROLLBACK(REFUND)` → segundo `REFUND`. O segundo é `REFERENCE_ALREADY_REVERSED`. Saldo 75 no exemplo 100/25 |
| `TI-REVERSAL-OVERDRAW` | §7 regra 9 | D12 | `ROLLBACK` de crédito que negativaria usa `REVERSAL_INSUFFICIENT_FUNDS`, sem lançamento |
| `TI-RECONCILE` | §9 | D8 | Divergência criada por SQL no saldo da wallet: resposta sinaliza, métrica sobe, ledger e saldo não são corrigidos |
| `TI-HEALTH-LOGS` | §9, §12 | D2 | Live sem dependência. Ready falha se PostgreSQL ou SQS caem. Log JSON com os ids de correlação e sem corpo financeiro |
| `TI-METRICS` | §12 | D10, D14 | Contadores de status, duplicata, retry, DLQ, conflito de lock, outbox lag e latência sobem nos casos correspondentes |
| `TI-PENDING-ATTEMPTS` | §7.1 | D11 | Esgota as tentativas do perfil de teste com `deadline_at` ainda no futuro. `REFERENCE_NOT_FOUND` se a referência não existe. Saldo e ledger intocados |
| `TI-PENDING-TTL-STOPPED` | §7.1 | D11 | Worker parado, TTL curto vencido, um tick ao religar. `REFERENCE_NOT_FOUND`. `attempt_count` não foi até o máximo |
| `TI-PENDING-ARRIVES` | §7.1, §13 cenário 7 | D11 | A referência chega durante o backoff e aplica uma vez |
| `TI-PENDING-REF-REJECTED` | §7.1 | D11, D12 | Referência persistida `REJECTED` vira `REFERENCE_NOT_PROCESSED` sem esperar o TTL |
| `TI-PENDING-REPLAY` | §7.1, §9 | D11, D12 | Replay HTTP e redelivery SQS não incrementam `attempt_count` e não empurram a pendência à DLQ |
| `TI-PENDING-RESTART` | §7.1, §13 cenário 8 | D11 | Restart no backoff preserva `attempt_count`, `next_attempt_at` e `deadline_at` |
| `TI-SIGTERM` | §10 | D9 | `SIGTERM` antes do commit devolve a visibilidade. Outra instância conclui sem segundo lançamento |

### Concorrência

Três ou mais processos Bun, pids distintos, mesmo PostgreSQL e mesmo LocalStack.

| ID | Requisito | Decisão | Assert |
|---|---|---|---|
| `TC-1` | §13 cenário 1, §5.2 | D6, D13 | 50 submissões simultâneas da mesma aposta. Um `DEBIT`. As demais são replay |
| `TC-2` | §8, §13 cenário 2 | D5, D13 | Duas `BET` de `80.00` sobre `100.00`. Uma `PROCESSED`, uma `REJECTED` com `INSUFFICIENT_FUNDS`, saldo `20.00`, um `DEBIT`. Retry não debita de novo |
| `TC-3` | §8, §13 cenário 3, §5.6 | D5 | Lock preso na wallet A. Operação da wallet B conclui durante a espera |
| `TC-4` | §8, §13 cenário 4 | D13 | `TC-1`, `TC-2` e `TC-6` rodam nos três processos |
| `TC-5` | §13 cenário 5 | D9 | Kill depois do commit e antes do ack. Outra instância não duplica o lançamento |
| `TC-5-PUBLISH` | §11 | D9, D10 | Kill depois do commit e antes do publish. Outra instância publica o mesmo `eventId` |
| `TC-6` | §13 cenário 6 | D10, D13 | Dois publishers em processos diferentes, sobrepostos. Um envio por `eventId` |
| `TC-7-HAPPY` | §13 cenário 7 | D7, D11 | `REFUND` e, em caso separado, `ROLLBACK`, chegam antes da referência. Quando ela chega: um estorno e um lançamento. Este teste não esgota TTL |
| `TC-7-RACE` | §7, §8 | D7 | Duas reversões da mesma referência ao mesmo tempo. Um `PROCESSED`, um lançamento. O perdedor fica `REJECTED` com `REFERENCE_ALREADY_REVERSED` |
| `TC-REVERSAL-WIN-AND-REFUND` | §7 | D7 | `ROLLBACK` da `WIN` e `REFUND` da `BET` ficam os dois `PROCESSED` |
| `TC-PENDING-WORKERS` | §8, §7.1 | D11, D13 | Três instâncias do worker e uma referência. Um crédito |
| `TC-8` | §13 cenário 8 | D9 | Restart no meio da carga dos cenários 1, 2 e 7. Consistência pela invariante do ledger |

`TI-OUTBOX` prova o claim sequencial. `TC-6` prova a sobreposição de processos. `TC-5` é a morte antes do ack. `TC-5-PUBLISH` é a morte antes do publish. `TC-8` é a consistência depois do restart. `TI-SIGTERM` é o desligamento com a transação ainda aberta.

## 7. Fases

Cada fase começa com a anterior verde. Código de produção só depois do sim das divergências. A fase 0 desta revisão não executa migration.

| Fase | Entrega | Pronto quando |
|---|---|---|
| 0 | `ARCHITECTURE.md` e esta proposta | Divergências aprovadas. D1–D14 com as condições desta revisão |
| 1 | Bun, Nest strict, Compose com imagens pinadas, Postgres, LocalStack, health, migration vazia reversível | live 200 e ready 200. MikroORM 6 e `pg` sobem. Sem coluna de dinheiro |
| 2 | Domínio puro e testes de unidade | `TU-MONEY-*`, `TU-HASH`, `TU-WALLET`, `TU-REHYDRATE`, `TU-RULES-*`, `TU-REVERSAL-SLOT`, `TU-CURRENCY`, `TU-IDEMPOTENCY`, `TU-STATE`, `TU-EVENTS` |
| 3 | Migration financeira, abertura de wallet, reconciliação | `TI-SCHEMA`, `TI-MONEY-DRIVER`, `TI-WALLET-HTTP`, `TI-RECONCILE` |
| 4 | Submit síncrono, lock, idempotência, ledger, mapa HTTP | Replay com snapshot e o cenário das duas apostas ainda dentro de um processo, como checkpoint. O cenário §13 com três processos fica na fase 7 |
| 5 | Consumidor, inbox, outbox, DLQ, `SIGTERM` | `TI-ATOMIC`, `TI-INBOX`, `TI-DLQ`, `TI-DLQ-INVALID`, `TI-OUTBOX`, `TI-OUTBOX-DURABLE`, `TI-SIGTERM` |
| 6 | Worker de `PENDING_REFERENCE` | `TI-PENDING-*` e `TC-7-HAPPY`. Tentativas e TTL são testes separados |
| 7 | Corrida com 3 processos e recuperação de crash | `TC-1` a `TC-8`, `TC-5-PUBLISH`, `TC-7-RACE`, `TC-REVERSAL-WIN-AND-REFUND`, `TC-PENDING-WORKERS`, invariante do ledger |
| 8 | Logs, métricas, README operacional | `TI-HEALTH-LOGS`, `TI-METRICS`, rubrica de documentação |
| 9 | Opcional: `bun run test:load` | Metodologia, p50/p95/p99, erro, lock e outbox lag registrados |

## 8. Critérios de aceite desta revisão

`ARCHITECTURE.md` e este arquivo contam a mesma decisão para D1–D14, o mesmo schema desenhado e a mesma matriz.

A implementação continua bloqueada até aprovação explícita das divergências. Nenhuma migration foi executada.
