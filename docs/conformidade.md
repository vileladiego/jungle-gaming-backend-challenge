# Matriz de conformidade

Comparação com o `README.md` da Jungle Gaming. Status só é `atendido` quando há teste executado, ou quando o requisito é estrutural e o teste de build/lint o cobre. A suíte distribuída é `bun run test:distributed`. A suíte principal é `bun test`.

Nenhum item abaixo é bloqueio da correção financeira.

## Stack e restrições

| Requisito | Implementação | Arquivos | Teste | Status | Risco residual |
| --- | --- | --- | --- | --- | --- |
| §4 Bun 1.x, TypeScript strict, NestJS | Bun 1.4.4, `strict` e Nest 11 | `package.json`, `tsconfig.json`, `src/main.ts` | `bun test`, `bun run build` | atendido | O avaliador precisa do Bun no `PATH`. `.tools/` não vai no Git. |
| §4 PostgreSQL, SQS LocalStack, Compose, migrations reversíveis | Postgres 16.10, LocalStack 4.7, três migrations com `down` | `docker-compose.yml`, `src/persistence/migrations/` | `test/phase1.integration.test.ts`, `test/persistence.integration.test.ts` | atendido | LocalStack sem volume. Ver limitações. |
| §4 MikroORM, sem Prisma | MikroORM 6 e `EntityManager.transactional` | `src/persistence/` | suíte de persistência | atendido | Nenhum. |
| §5.1 Dinheiro não é `number` | `decimal.js`, `numeric(20,2)`, string nas bordas | `src/domain/money/money.ts`, `src/persistence/numeric-string.type.ts` | `test/money.unit.test.ts`, teste de precisão HTTP | atendido | Nenhum. |
| §5.2 Idempotência não é cache em memória | `UNIQUE` da chave e da inbox | `src/persistence/financial-store.ts` | persistência, HTTP e distribuída (50 POST) | atendido | Nenhum. |
| §5.3 FIFO não é a garantia | Inbox, unique e `eventId` | `sqs-wager-consumer.ts`, `distributed/event-consumer-main.ts` | `test/async.integration.test.ts`, dedup da suíte distribuída | atendido | O consumidor que persiste `eventId` é de teste. A janela de 5 min do FIFO não foi esperada. |
| §5.4 Não publicar antes do commit | Outbox na mesma transação; `SendMessage` depois | `financial-store.ts`, `outbox-publisher.ts` | crash antes do publish na suíte distribuída | atendido | Nenhum. |
| §5.5 Ledger imutável | Trigger `BEFORE UPDATE OR DELETE` | migration financeira | teste de imutabilidade na persistência | atendido | Nenhum. |
| §5.6 Sem lock global | `FOR UPDATE` da wallet | `financial-store.ts` | wallet B conclui com A travada, suíte distribuída | atendido | Nenhum. |
| §5.7 Sem read-calculate-update solto | Lock e constraints de saldo | `financial-store.ts`, migration | duas apostas de 80.00 em HTTP, persistência e distribuída | atendido | Nenhum. |
| §5.8 Várias instâncias | Três ou mais processos Bun | `distributed/concurrency.suite.ts` | `bun run test:distributed` | atendido | `bun test` sozinho não prova esta linha. |
| §5.9 Constraints no schema | Unicidade, não-negatividade, imutabilidade | migration financeira | testes de constraint da fase 3 | atendido | `ingress_rejects` não é única por mensagem. |

## Domínio

| Requisito | Implementação | Arquivos | Teste | Status | Risco residual |
| --- | --- | --- | --- | --- | --- |
| §6.0 Factory e `rehydrate` sem revalidar transição | `create`, `rehydrate` | `src/domain/wager/wager-transaction.ts`, `src/domain/wallet/wallet.ts` | `test/wager.unit.test.ts`, `test/wallet-ledger.unit.test.ts` | atendido | Nenhum. |
| §6.1 Money string, escala e ISO | Canoniza até 2 casas; rejeita número, `"brl"` e zero externo | `src/domain/money/money.ts` | `test/money.unit.test.ts` | atendido | Divergências 2, 3 e 4 de `ARCHITECTURE.md`. |
| §6.2 Wallet, version só quando o saldo muda | Version 1 na abertura positiva; `LOSS` não incrementa | `src/domain/wallet/` | unidade e replay da suíte distribuída | atendido | Nenhum. |
| §6.3 Transação, estados terminais, `FAILED` auditável | Terminais congelados. `FAILED` só para constraint desconhecida, sem ledger | `wager-transaction.ts`, `postgres-error.ts`, `financial-store.ts` | unidade e `constraint desconhecida grava FAILED` | atendido | `FAILED` não foi reexecutado com três processos. |
| §6.4 Ledger append-only, um lançamento por transação | `UNIQUE (transaction_id)` e checks aritméticos | migration, `wallet-ledger-entry.ts` | persistência e invariante da suíte distribuída | atendido | A cadeia entre linhas é do lock e do teste, não de um check entre linhas. |
| §6.5 Inbox e outbox na mesma transação do efeito | Inbox só no caminho SQS | `financial-store.ts` | atomicidade da fase 3 e inbox da fase 4B | atendido | HTTP não grava inbox, como a D9. |

## Regras de negócio

| Requisito | Implementação | Arquivos | Teste | Status | Risco residual |
| --- | --- | --- | --- | --- | --- |
| §7 BET, WIN, LOSS, REFUND, ROLLBACK | Regras no agregado, não no consumidor | `src/domain/wager/apply-wager.ts` | `test/wager.unit.test.ts`, HTTP | atendido | Nenhum. |
| §7 regra 4, uma reversão | D7: uma `PROCESSED` por referência, qualquer kind | índice `ux_reversal_once` | HTTP, persistência e corrida distribuída | atendido | Mais estreito que o texto literal. Documentado. |
| §7 regra 7, replay com saldo observado | Snapshot gravado; replay não lê o saldo vivo | `submission-http.ts`, store | HTTP e suíte distribuída | atendido | Nenhum. |
| §7.1 Referência fora de ordem | Worker, backoff, TTL 15 min, rejeição com evento | `pending-reference-worker.ts` | `test/async.integration.test.ts`, três workers na suíte distribuída | atendido | `attempt_count` pode ser regravado se o lease vencer. Sem segundo crédito no teste. |
| §7.2 failureCode estável | Taxonomia em `ARCHITECTURE.md` | `src/domain/failure-code.ts` | HTTP cobre os códigos do mapa D12 | atendido | Nenhum. |
| §3 At-least-once, fora de ordem, processo morto, Postgres e SQS fora | Inbox, outbox, worker, redelivery | messaging e store | fase 4B e suíte distribuída | atendido | Ver limitações de `57P03` e LocalStack. |

## Concorrência

| Requisito | Implementação | Arquivos | Teste | Status | Risco residual |
| --- | --- | --- | --- | --- | --- |
| §8 Cenário 100 / 80 / 80 | Uma processada, uma `INSUFFICIENT_FUNDS`, saldo 20.00, um débito | store | persistência, HTTP e distribuída | atendido | Nenhum. |
| §13.1 50 envios, um débito | 50 POST em três processos | `distributed/concurrency.suite.ts` | suíte distribuída | atendido | Nenhum. |
| §13.3 Wallets em paralelo | Lock só da wallet A | `distributed/hold-wallet-lock.ts` | B conclui em menos de 2 s | atendido | Nenhum. |
| §13.4 Três ou mais processos | PIDs distintos, mesmo banco e mesma fila | suíte distribuída | execução da fase 5 e da 6A | atendido | Nenhum. |
| §13.5 Morte depois do commit e antes do ack | `SIGKILL` depois do commit do caso de uso | `distributed/crash-main.ts` | um débito e uma inbox | atendido | O harness pede visibility de 2 s. A fila da aplicação continua em 60 s. |
| §13.6 Dois publishers | Três processos com `SKIP LOCKED` | `outbox-publisher.ts`, `publisher-main.ts` | eventIds disjuntos | atendido | Nenhum. |
| §13.7 Reversão antes da referência | `REFUND` pendente, três workers, depois a `BET` | worker de referência | um crédito | atendido | O caso separado de `ROLLBACK` antes da referência não foi repetido na suíte distribuída. O mesmo worker e a mesma regra cobrem o kind. |
| §13.8 Restart e consistência | Restart dos containers sem apagar volume | suíte distribuída | débito anterior único; aposta nova uma vez | atendido | Não foi restart no meio da carga misturada dos cenários 1, 2 e 7. |

## HTTP, SQS, outbox, observabilidade

| Requisito | Implementação | Arquivos | Teste | Status | Risco residual |
| --- | --- | --- | --- | --- | --- |
| §9 Criar wallet, consultas, ledger paginado | POST, GET, cursor HMAC | `wallets.controller.ts`, `ledger-cursor.ts` | `test/http.integration.test.ts` | atendido | O cursor é assinado e legível em base64. |
| §9 Submeter transação e mapa de status | 400, 409, 422, 202, 200, 503, 500 e 404 | `submission-http.ts` | HTTP, inclusive replay de `FAILED` com 500 e saldo intacto | atendido | O gatilho do 500 no teste é uma constraint de prova, não um caminho de negócio. |
| §9 Reconciliação não corrige | Compara e sinaliza | `reconcile-wallet.service.ts` | HTTP | atendido | O contador de divergência é do processo. |
| §9 e §12 Health sem autenticação | live e ready | `health.controller.ts` | fase 1 e fase 4B | atendido | Nenhum. |
| §2 Autenticação a cargo do candidato | `AuthGuard` no-op nas rotas financeiras. Health aberto. | `auth.guard.ts` | `test/auth-guard.unit.test.ts` | parcial | Não autentica. A D2 adia o IdP. O enunciado não pontua autenticação. |
| §10 Mesmo caso de uso, inbox, ack após commit | `submitFromQueue` | `sqs-wager-consumer.ts`, `submit-wager.service.ts` | fase 4B e crash distribuído | atendido | Nenhum. |
| §10 Negócio confirma, transitório não, permanente vai à DLQ | Mapa da D14 | consumer e `postgres-error.ts` | fase 4B | atendido | `57P03` cai em `other` e derruba o processo. Não vira `FAILED`. |
| §10 `SIGTERM` | `worker-main.ts` chama `stop()` | `src/worker-main.ts` | processo real na suíte distribuída | atendido | Nenhum. |
| §11 Outbox depois do commit, publishers concorrentes, eventos mínimos | Quatro tipos de evento; linha conservada | `src/domain/events/`, publisher | unidade, fase 4B e distribuída | atendido | Sem consumidor de produção da fila de domínio. |
| §12 Logs JSON sem payload financeiro | Allowlist de campos | `json-log.ts` | unidade e canário da DLQ na suíte distribuída | atendido | Um erro não tratado do driver pode ir ao stderr. |
| §12 Métricas pedidas | Contadores em memória | `processing-metrics.ts` | incrementos na fase 4B | atendido | Sem endpoint. Morrem com o processo. |
| §14 Diferencial de carga e OpenTelemetry | Não implementados | — | — | não atendido | Opcional. Fora desta entrega em `ARCHITECTURE.md`. |

## Classificação dos riscos

| Problema | Classe |
| --- | --- |
| Recuperação após `FATAL 57P03` | Melhoria recomendada. O débito commitado permaneceu único. Não é bloqueio. |
| `attempt_count` concorrente | Limitação documentada. O teste não viu segundo crédito. |
| `ingress_rejects` duplicado | Limitação documentada. Não move saldo. |
| Dedup por `eventId` só no teste | Limitação documentada. O processador não reaplica saldo a partir do evento. |
| LocalStack sem volume | Limitação documentada e aceitável para o Compose local. |
| `AuthGuard` no-op | Limitação documentada. A D2 e o enunciado permitem adiar. |
| `FAILED` e transitórios | Atendido no código e na suíte de persistência. `57P03` é a melhoria acima, não um `FAILED` indevido. |
| Invariantes depois das falhas | Atendido na suíte distribuída. Não é bloqueio. |
