# Persistência financeira

A migration `Migration20261029160100_Financial` materializa o schema de `ARCHITECTURE.md`. O papel `wager_app` executa a aplicação. O papel `wager`, dono das tabelas, executa as migrations. `wager_app` tem `SELECT`, `INSERT`, `UPDATE` e `DELETE`. Não tem `TRUNCATE` e não é dono, então não desliga o trigger do ledger.

`NUMERIC(20,2)` entra e sai como string. O tipo `NumericStringType` recusa `number`.

`PENDING_REFERENCE` grava `attempt_count = 0`. `next_attempt_at` e `deadline_at` saem de `now()` do PostgreSQL na mesma sentença: o prazo é `now() + ttl`. O padrão é 15 minutos. `REFERENCE_TTL_MS` só existe para o perfil de teste. `created_at` e `processed_at` continuam no relógio recebido pelo caso de uso, para o teste fixar o instante de negócio. Replay não reescreve o prazo.

`FAILED` só é gravado quando `persistsAsFailed` é verdadeiro: constraint `23505` ou `23514` cujo nome o código não reconhece. Timeout, deadlock, serialização, unicidade conhecida, check de saldo, estouro `22003` e trigger de imutabilidade não entram nesse ramo.

As constraints da migration nascem validadas. `NOT VALID` não faz parte do schema. Um banco novo aceita o mesmo predicado de prova (`status <> 'PROCESSED'`) já validado, porque a tabela ainda está vazia.

## Ordem de locks

Uma transação financeira trava no máximo uma wallet. A ordem é fixa:

1. `SET LOCAL lock_timeout = 3s` e `statement_timeout = 5s`.
2. `SELECT` da wallet `FOR UPDATE` quando a linha existe. Sem `SKIP LOCKED` e sem `LOCK TABLE`.
3. Se a primeira leitura não acha a wallet, um segundo `SELECT` na mesma transação. Se a linha apareceu, `FOR UPDATE`. Se continua ausente, grava `REJECTED` / `WALLET_NOT_FOUND`, a inbox quando houver mensagem e a outbox de rejeição. Sem ledger e sem saldo observado.
4. Reler idempotência e inbox sob o lock.
5. Aplicar o domínio.
6. Inserir o ledger só se o saldo mudou.
7. Atualizar saldo e `version` com `WHERE id AND version`.
8. Inserir a transação e a outbox.
9. Commit.

Abertura não faz `FOR UPDATE` prévio: insere a wallet na versão 1. Saldo positivo grava, na mesma transação, o `CREDIT` com `balance_before = 0.00`, a transação `OPENING` `PROCESSED` e a outbox. Saldo zero grava só a wallet. Conflito de `(player_id, currency)` é `WALLET_ALREADY_EXISTS`, não `FAILED`.

Replay devolve o snapshot já gravado. Não insere outro ledger nem outra outbox.

`FAILED` só nasce numa transação nova, quando a constraint de unicidade ou de verificação tem nome desconhecido. Essa transação não altera saldo, não insere ledger e não insere outbox. Timeout (`55P03`), deadlock (`40P01`), cancelamento (`57014`) e serialização (`40001`) são transitórios: a transação desfaz e o erro sobe. Estouro `22003` vira `REJECTED` / `AMOUNT_OVERFLOW`.

## Deadlock e workers futuros

O ciclo evitado é travar a wallet e depois a transação numa sessão, e a transação e depois a wallet em outra. A transação financeira trava a wallet primeiro e não trava linhas de inbox ou outbox com `FOR UPDATE`.

O worker de referência faz `SKIP LOCKED` só na linha `PENDING_REFERENCE`, grava o lease em `next_attempt_at` e encerra essa transação sem a wallet. Uma transação nova então trava a wallet e relê o status. O publisher faz `SKIP LOCKED` só na outbox, commita o lease e só então envia. `published_at` entra depois do envio confirmado. A linha publicada permanece.

Três instâncias na mesma wallet esperam o `FOR UPDATE`. O timeout é transitório. Não há lock global.

O dono do schema ainda pode `TRUNCATE` e desligar triggers. A aplicação não usa esse papel.

A migration do papel não entra na mesma transação do schema: `CREATE ROLE` e `DROP ROLE` recusam bloco transacional. Cada migration confirma sozinha. `down` do papel revoga os privilégios das tabelas antes do `DROP ROLE`. Enquanto a aplicação estiver conectada como `wager_app`, o papel não é removido.
