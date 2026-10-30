# Arquitetura — Distributed Wagering Processor

Status: decisões D1–D14 reescritas com as condições da revisão de Tech Lead, Security Reviewer e QA. Este arquivo é o registro das decisões. O detalhe operacional, o mapa HTTP e a matriz de testes estão em `docs/architecture-proposal.md`.

A fase 1 está implementada: Bun 1.4, NestJS 11, TypeScript strict, MikroORM 6.6, PostgreSQL 16.10, LocalStack 4.7, três filas FIFO, a migration vazia reversível e `GET /health/live` e `GET /health/ready`. Comandos e resultado da validação estão em `docs/setup.md`.

A fase 2 está no domínio puro: `Money`, `Wallet`, `WalletLedgerEntry` e `WagerTransaction`, com testes de unidade. Não há migration financeira, controller de negócio, SQS, worker, Inbox, Outbox nem persistência desses agregados. O schema financeiro abaixo continua desenho e não foi migrado.

Fonte de verdade do enunciado: `README.md`. Onde este arquivo aperta ou completa o enunciado, a diferença está na seção [Divergências](#divergências-em-relação-ao-readme).

## Invariantes

Fatos do README que o schema e o caso de uso sustentam juntos:

- O sistema não duplica crédito, não duplica débito, não perde evento confirmado e não persiste saldo negativo (§3, §5).
- Toda alteração de saldo tem um lançamento no ledger, e todo lançamento corresponde a uma alteração (§6.2, §6.4). `LOSS` e `REJECTED` não geram lançamento.
- Dinheiro entra, sai e é reidratado como string decimal. `number`, `float` e `double` não participam do caminho (§5.1, §6.1).
- Unicidade, imutabilidade e não-negatividade estão no schema (§5.9).
- A unidade de concorrência é a `walletId`. Não há lock global (§5.6, §8).
- Inbox (quando a entrada é SQS), saldo, ledger e outbox commitam na mesma transação SQL. Ack e publicação acontecem depois do commit (§6.5, §10, §11).
- A mesma idempotency key com outro payload é conflito. Replay devolve o resultado original, inclusive o saldo observado naquele momento (§6.3, §7 regra 7, §9).
- Em todo teste de integração e de concorrência, a cadeia `balance_before` / `balance_after` fecha e o saldo da wallet é o último `balance_after`, ou o saldo inicial quando não há lançamento.

## Decisões

### D1 — MikroORM 6 e domínio separado da persistência

O README prefere MikroORM pelo Unit of Work, `EntityManager.transactional()` e `LockMode` (§4). `Money` e os agregados não dependem de decorator do NestJS nem de tipo monetário do ORM (§6.0, §6.1).

O repositório é o único escritor. A entidade de persistência guarda `numeric` como `string`. `rehydrate` recebe essa string e só então chama `Money`. `rehydrate` não revalida transição (§6.0). O versionamento automático do MikroORM fica desligado: `version` sobe só quando o saldo muda (§6.2).

Trade-off: dois modelos para mapear. A fronteira impede que um type parser do driver vaze `number` para o agregado.

A fase 1 provou Bun 1.x, NestJS, MikroORM 6 e o driver `pg` com a migration vazia. A migration de dinheiro ainda não existe.

### D2 — Autenticação adiada

A seção 2 não pontua autenticação e aceita omitir o IdP se o desenho e o ponto de extensão ficarem documentados. Health fica aberto (§9). A fila é canal interno confiável. A identidade do provedor na mensagem continua na validação de domínio (§2).

`AuthGuard` no-op protege `POST /wallets`, `POST /wagering/transactions`, a reconciliação e as consultas. Health fica fora do guard. `ProviderIdentityPort` é o encaixe futuro. O IdP previsto é Keycloak ou Zitadel, em Docker Compose, OIDC, sem tabela própria de senha.

Exposição residual aceita pelo enunciado: quem alcança a API pode informar qualquer `providerId`. O guard no-op não pula validação de kind, dinheiro, hash, escopo nem `providerId`. `/health/ready` responde só se as dependências estão alcançáveis, sem URL nem credencial.

`providerId` é string obrigatória, charset `[A-Za-z0-9._-]{1,64}`, comparada de forma exata. O prefixo `internal` é reservado à abertura de wallet e a borda recusa esse prefixo em API e fila.

### D3 — BRL no fluxo principal, Money multi-moeda

O README permite assumir uma moeda para reduzir o cenário, com o modelo multi-moeda e conflito de moeda testado (§6.1). Qualquer código que passe em `^[A-Z]{3}$` abre wallet. `BRL` é a moeda dos cenários do enunciado. Uma segunda moeda real, no agregado e na persistência, cobre o conflito. Recusar `EUR` na borda esvaziaria `UNIQUE (player_id, currency)`.

### D4 — Money em decimal.js, numeric exato, string nas duas pontas

`number` para dinheiro é eliminatório (§5.1). O contrato recebe e serializa string com escala 2 (§6.1).

`Money` guarda um `Decimal` de `decimal.js` e não o expõe. Precisão interna 40, configurada no boot do domínio. Operações são `add`, `subtract` e `negate`, e devolvem outra instância (§6.1). O domínio não chama `toNumber`, `Number`, `parseFloat` nem `toDecimalPlaces` sobre entrada crua.

A validação lexical acontece antes de construir o `Decimal`, antes do hash e antes do `INSERT`. Não há arredondamento. `numeric(20,2)` não rejeita escala excedente: o PostgreSQL arredonda o excesso. A regex é a barreira. Se uma soma de escala 2 não couber na precisão da coluna, o erro vira `AMOUNT_OVERFLOW`, não `FAILED`.

Forma aceita para `amount`, como string JSON:

```text
^(0|[1-9]\d{0,17})(\.\d{1,2})?$
```

Depois do casamento, o texto é preenchido até duas casas, sem alterar o valor: `"25"` e `"25.0"` viram `"25.00"`. `"25.000"`, `"1e1"`, `"NaN"`, `"Infinity"`, vazio, sinal, branco e zero à esquerda (`"025.00"`) não casam e morrem como `INVALID_PAYLOAD`. Número JSON (`"amount": 25`) é `INVALID_PAYLOAD`: o parser HTTP já teria passado por `number`.

Moeda aceita: `^[A-Z]{3}$`. `"brl"` é `INVALID_PAYLOAD`. Não há conversão silenciosa para maiúsculas.

A string canônica é a que entra no hash, na coluna e na resposta. Colunas de valor são `numeric(20,2)`. Colunas de moeda são `varchar(3)` com `CHECK (currency ~ '^[A-Z]{3}$')`. `char(3)` fica de fora: `bpchar` pode devolver espaço e quebrar a igualdade no domínio.

O driver e o MikroORM devolvem `numeric` como `string`. A propriedade da entidade é `string`. Um tipo explícito do MikroORM recusa `number`. Nenhum parser do OID 1700 chama `parseFloat`. O teste de ida e volta usa um valor fora do inteiro seguro de IEEE-754, por exemplo `"9007199254740993.99"`, e compara a string.

Valor que não cabe em `numeric(20,2)`, na entrada ou numa soma de escala 2, é rejeição de negócio `AMOUNT_OVERFLOW`, status `REJECTED`, com `WagerTransactionRejected`. Não é `PERSISTENT_STATE_CORRUPT`.

O preenchimento acontece antes da regra de zero. `"0"` e `"0.0"` viram `"0.00"`. Esse valor é `INVALID_PAYLOAD` em `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`. O ledger exige `amount > 0`, e um zero aceito na transação estouraria esse `CHECK` como se fosse corrupção. Saldo inicial `"0.00"` na abertura é válido: a wallet nasce com `version = 1`, sem `OPENING` e sem lançamento.

Trade-off: preencher `"25"` até `"25.00"` trata textos de escala curta como o mesmo valor. A alternativa era rejeitá-los. O enunciado exige serializar com duas casas e rejeita mais de duas; não lista escala menor como inválida (§6.1).

Limitação: `decimal.js` arredonda se alguém chamar `toFixed` numa string que pulou a regex. A regra de implementação é uma única função de borda, compartilhada por HTTP, SQS, hash e `Money.from`.

### D5 — FOR UPDATE por wallet

A unidade de concorrência é a `walletId` (§8). `SELECT … FOR UPDATE` da wallet serializa as instâncias no banco. Outras wallets seguem em paralelo. Não há `LOCK TABLE`, advisory lock global nem `SKIP LOCKED` na wallet (§5.6). `MessageGroupId = walletId` só reduz contenção na fila (§5.3, §8).

`version` nasce em 1. O saldo inicial positivo permanece em 1, com `OPENING` e `CREDIT` na mesma transação, como no exemplo HTTP (§9). Depois da abertura, `version` sobe em `BET`, `WIN`, `REFUND` e `ROLLBACK` que alteram o saldo. `LOSS` e `REJECTED` não sobem `version` e não emitem `WalletBalanceChanged`.

`LOSS` também toma `FOR UPDATE`. O snapshot do saldo observado precisa ser o saldo commitado no momento da `LOSS`. A linha da wallet não recebe `UPDATE` nesse caminho: nem `version`, nem `updated_at`.

Quando o saldo muda, o `UPDATE` leva `WHERE id = ? AND version = ?`. Se o lock for esquecido, a escrita falha fechada.

`lock_timeout` de 3s e `statement_timeout` de 5s. Timeout, deadlock e queda de conexão desfazem a transação e seguem como falha transitória: HTTP 503, retry na fila, sem `REJECTED` e sem `FAILED`. O visibility timeout da mensagem é 60s, acima dessa espera e do trabalho da transação. Três instâncias na mesma wallet não mandam aposta válida para a DLQ por estouro de receive.

Abertura concorrente não tem linha para travar. O `UNIQUE (player_id, currency)` responde 409 `WALLET_ALREADY_EXISTS`.

### D6 — Idempotência no banco e snapshot

O header `Idempotency-Key` é a fonte da verdade no HTTP. Na fila, a fonte é `data.idempotencyKey` (§9, §10). Os dois canais exigem que a key seja exatamente `{providerId}:{externalTransactionId}`. Key ausente, ou key que não bate com o par do corpo, é `INVALID_PAYLOAD` e não persiste. O enunciado recomenda esse formato; torná-lo obrigatório impede duas identidades para o mesmo efeito. Está listado como divergência.

Persistência:

- `UNIQUE (idempotency_key)`
- `UNIQUE (provider_id, external_transaction_id)`
- `payload_hash` SHA-256 hex em minúsculas
- saldo observado, nulo só quando a wallet não existe

O hash cobre o JSON canônico UTF-8, chaves ordenadas em todos os níveis, sem espaço insignificante. Entram `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount` já canônico, `money.currency` já canônico, e `referenceExternalTransactionId` somente quando o campo está presente e não é vazio. Ficam de fora o header, `messageId`, `occurredAt` e qualquer metadado de transporte. `null` ou string vazia no campo de referência é `INVALID_PAYLOAD`. Omissão do campo significa referência ausente.

Resolução, de novo depois do lock da wallet:

1. Key existente e hash igual: devolve o snapshot. Não insere ledger nem outbox.
2. Key existente e hash diferente: 409 `IDEMPOTENCY_PAYLOAD_MISMATCH`, sem persistir outra linha.
3. Key nova e o par provider + external já existe: 409 `IDEMPOTENCY_KEY_MISMATCH`.
4. Os dois ausentes: processa.

Corrida de duas requisições iguais: uma insere, a outra toma unique violation. A transação aborta. Uma transação nova relê pela key. Hash igual responde replay. Hash diferente, ou par já preso a outra key, responde 409. Essas constraints conhecidas não viram `FAILED`.

O snapshot congela o saldo da transição. Enquanto o status é `PENDING_REFERENCE`, o replay devolve esse saldo da aceitação. No estado terminal, o snapshot é o saldo da transição terminal. Reler a wallet no replay quebraria a regra 7.

### D7 — Uma reversão PROCESSED por transação referenciada

O README (§7 regra 4) diz que uma referência não pode ser revertida duas vezes pelo mesmo tipo. Lida sozinha, um `REFUND` e um `ROLLBACK` da mesma `BET` passariam. Os dois creditam o mesmo valor. Saldo `100.00`, `BET` `25.00`, `REFUND` e `ROLLBACK` dessa `BET` terminariam em `125.00`. Isso duplica crédito (§3).

A frase final da §7 manda documentar interpretação adicional. A decisão aperta a regra 4: cada transação referenciada admite no máximo uma reversão `PROCESSED`, seja `REFUND` ou `ROLLBACK`. O segundo pedido, mesmo de outro kind, fica `REJECTED` com `REFERENCE_ALREADY_REVERSED` e publica `WagerTransactionRejected`.

```sql
CREATE UNIQUE INDEX ux_reversal_once
  ON wager_transactions (reference_transaction_id)
  WHERE status = 'PROCESSED'
    AND kind IN ('REFUND', 'ROLLBACK');
```

`REJECTED` e `FAILED` não ocupam a vaga. `CHECK` complementar: `PROCESSED` com kind `REFUND` ou `ROLLBACK` exige `reference_transaction_id` não nulo. Vários `NULL` não conflitam no unique do PostgreSQL.

Caminho da corrida, sob `FOR UPDATE` da wallet:

1. A segunda transação relê. Se já existe reversão `PROCESSED` daquela referência, rejeita no domínio.
2. Se o índice ainda estourar, a transação aborta. Uma transação nova, de novo com o lock da wallet, grava `REJECTED`, `REFERENCE_ALREADY_REVERSED`, o snapshot e `WagerTransactionRejected`.
3. O mapeamento é pelo nome `ux_reversal_once`. O ramo `PERSISTENT_STATE_CORRUPT` não vê essa constraint.

`ROLLBACK` de um `REFUND` aponta para o `REFUND`, não para a `BET`. A vaga da `BET` continua ocupada, porque o `REFUND` segue `PROCESSED` e terminal não muda (§6.3). Depois de `BET` → `REFUND` → `ROLLBACK` do `REFUND`, outro `REFUND` da mesma `BET` recebe `REFERENCE_ALREADY_REVERSED`. No exemplo 100 e 25, o saldo fica `75.00`. Reabrir a vaga exigiria outro desenho e não faz parte desta entrega.

O índice não cria invariante de rodada. `ROLLBACK` de uma `WIN` e `REFUND` da `BET` usam referências diferentes e os dois podem ficar `PROCESSED`. Várias `WIN` da mesma `BET` continuam permitidas. `ROLLBACK` de `ROLLBACK` é `REFERENCE_KIND_NOT_ALLOWED`.

### D8 — Ledger append-only

O schema recusa sobrescrita e exclusão (§5.5, §5.9). Trigger `BEFORE UPDATE OR DELETE` no ledger. `REVOKE` sozinho não basta: o papel dono ignora grant. O papel da aplicação não é dono e não executa `TRUNCATE`.

Cada lançamento carrega `amount numeric(20,2) CHECK (amount > 0)`, moeda `varchar(3)`, `CHECK` de `CREDIT` (`balance_after = balance_before + amount`) e de `DEBIT` (`balance_after = balance_before - amount`), e `CHECK (balance_after >= 0)`. `UNIQUE (transaction_id)` fecha um lançamento por transação (§6.4). Sem `updated_at`.

A moeda do lançamento permite reidratar `Money` sem depender de um join. `CHECK` liga essa moeda à moeda da wallet no momento da escrita, por comparação na aplicação sob o lock, e a coluna tem o mesmo `CHECK` lexical.

O trigger da transação de aposta é outro. Nascem imutáveis: identificadores externos, key, hash, wallet, player, rodada, jogo, kind, valor, moeda e referência externa. Até o estado terminal ainda mudam: status, referência interna, `failure_code`, `processed_at`, snapshot e os campos de espera da D11. `PROCESSED`, `REJECTED` e `FAILED` congelam a linha (§6.3).

`UNIQUE (transaction_id)` numa corrida segue o remapeamento da D6: reler e replay se for a mesma transação. Não é corrupção genérica.

A corrente `balance_before` do lançamento seguinte igual ao `balance_after` anterior fica a cargo do lock da wallet e do teste. O `CHECK` de cada linha garante a aritmética local.

### D9 — Uma transação SQL, ack e publish depois

Inbox, alteração de saldo, ledger e outbox commitam juntos quando a entrada é SQS (§6.5). HTTP não grava inbox. Publicar ou dar ack antes do commit é eliminatório (§5.4, §10, §11).

Ordem, igual no HTTP, na fila e no worker de referência:

1. `SELECT` da wallet `FOR UPDATE` quando a linha existe.
2. Resolver idempotência e inbox de novo, já sob o lock.
3. Aplicar a regra de domínio.
4. Inserir o ledger se a operação altera saldo e foi aceita.
5. Atualizar saldo e `version` somente se o saldo mudou.
6. Persistir status, `failure_code` e snapshot.
7. Inserir a outbox.
8. Commit.
9. Só então responder HTTP ou dar ack.

Isolamento `READ COMMITTED` com esse lock cobre a seção 8. Uma leitura da key antes do lock pode atalhar replay de estado terminal. A decisão que vale é a leitura de novo depois do lock.

Wallet ausente: um segundo `SELECT` na mesma transação. Se a wallet apareceu, o fluxo segue com `FOR UPDATE`. Se continua ausente, persiste `REJECTED` / `WALLET_NOT_FOUND`, inbox e `WagerTransactionRejected`, sem ledger e sem saldo observado. Não há FK de `wager_transactions.wallet_id` para `wallets`, porque a rejeição guarda o id pedido. O caminho que move saldo só commita com a linha da wallet travada.

Inbox: `consumer_name` é a constante `wager-transactions` em todas as instâncias. PK `(consumer_name, message_id)`. No conflito, reler. Hash igual e `processed_at` preenchido: ack sem efeito. Hash igual e ainda não processado: não dar ack. Hash diferente: não aplicar efeito, gravar `ingress_rejects` sem corpo financeiro, enviar a mensagem à DLQ e só então ack. Ack no unique antes do commit do vencedor some com a mensagem.

`statement_timeout` não cobre `SendMessage`. Publicar fica fora da transação financeira (D10). 503 não abre outra transação para gravar `FAILED`.

`SIGTERM` para o polling, espera o handler em curso e, se o commit não ocorreu, devolve a visibilidade.

### D10 — Outbox

A fila de saída não tem nome no enunciado. `wager-domain-events.fifo` é a fila desta arquitetura. `MessageGroupId = walletId`. `MessageDeduplicationId = eventId`. Deduplicação por conteúdo do FIFO fica desligada.

Publishers concorrentes reivindicam com `FOR UPDATE SKIP LOCKED`. Dentro de uma wallet, só o evento não publicado mais antigo (`occurred_at`, `id`) pode ser enviado. Se ele está em backoff, os seguintes dessa wallet esperam. Entre wallets o trabalho segue em paralelo.

O claim grava um lease em `next_attempt_at` e commita antes do `SendMessage`. `published_at` só depois do envio bem-sucedido. Crash no meio republica o mesmo `eventId`. A janela de 5 minutos da deduplicação do SQS FIFO não é a garantia (§8, §11). O consumidor deduplica por `eventId` persistido.

Backoff de publicação com teto de 60s, configurável nos testes. Evento já commitado não é apagado e não vai para uma DLQ de saída. Um evento que a SQS recusa de forma permanente segura o grupo daquela wallet. A métrica de outbox lag é o alarme. A intervenção é manual. Esses `attempts` são de publicação e não servem de contador da D11.

### D11 — Referência fora de ordem

O README (§7.1) pede worker com backoff exponencial, um limite definido por nós, e, esgotado o limite, `REJECTED` com código de referência inexistente e evento. A submissão que grava `PENDING_REFERENCE` dá ack no commit. O retry é o worker, não o redelivery da mensagem de comando.

Colunas em `wager_transactions`, distintas das colunas da outbox:

- `attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)`
- `next_attempt_at timestamptz`
- `deadline_at timestamptz`

`CHECK`: status `PENDING_REFERENCE` implica `next_attempt_at` e `deadline_at` não nulos.

Na inserção: `attempt_count = 0`, `next_attempt_at = now()` do PostgreSQL, `deadline_at = now() + ttl` vigente. Mudança de ambiente não reescreve prazo de linha já gravada. A submissão HTTP ou SQS não conta como tentativa.

Parâmetros lidos na subida do processo:

| Parâmetro | Operação | Teste |
|---|---|---|
| Visibility timeout da fila de entrada | 60s | 60s |
| `maxReceiveCount` | 5 | 5 |
| TTL da referência | 15 min | 3s |
| Lease do claim | 30s | 100ms |
| Tentativas do worker | 8 | 3 |
| Base do backoff | 1s | 50ms |
| Teto do backoff | 30s | 200ms |
| Intervalo de poll | 1s | 50ms |

O horizonte de cinco receives espaçados por 60s é 300s, mais a espera de grupo FIFO na mesma wallet. O TTL de 15 min fica acima desse horizonte. O TTL de 2 min da proposta anterior rejeitaria uma `BET` ainda invisível. Três segundos existem só no perfil de teste, para a suíte não dormir minutos. PostgreSQL e LocalStack continuam reais.

Fórmula, com `n` igual ao `attempt_count` depois do incremento:

```text
delay(n) = min(teto, base * 2^(n - 1))
```

Claim, com `now()` do PostgreSQL:

```sql
SELECT id
  FROM wager_transactions
 WHERE status = 'PENDING_REFERENCE'
   AND next_attempt_at <= now()
 ORDER BY next_attempt_at, id
 FOR UPDATE SKIP LOCKED
 LIMIT 1;
```

O claim empurra `next_attempt_at` um lease à frente e commita essa reserva sem incrementar `attempt_count`. Crash durante o lease devolve a linha a outro worker com o contador intacto. Em seguida a mesma transação de resolução toma `FOR UPDATE` da wallet e relê o status.

`attempt_count` sobe só quando essa resolução termina e a linha continua `PENDING_REFERENCE`. Replay HTTP, `GET` e redelivery com inbox já processado devolvem o snapshot e não mexem no contador nem no prazo.

Quem decide a rejeição:

- Referência inexistente e (`attempt_count` atingiu o máximo ou `now() >= deadline_at`): `REFERENCE_NOT_FOUND`.
- Referência em `REJECTED` ou `FAILED`: `REFERENCE_NOT_PROCESSED` na hora, sem gastar o prazo.
- Referência existente, ainda não terminal, com tentativas ou prazo esgotados: `REFERENCE_NOT_PROCESSED`.
- `WIN` sem o campo de referência processa na hora. `WIN` com o campo informado e a `BET` ainda ausente entra no mesmo worker.

Os dois relógios convivem. Com o worker no ar, as 8 tentativas da operação esgotam antes dos 15 min. Com o worker parado, `deadline_at` rejeita mesmo sobrando tentativa. O código segue o que a referência é no banco, não qual relógio disparou.

### D12 — HTTP

O mapeamento distingue payload inválido, conflito de idempotência, rejeição de negócio, aceite pendente, falha transitória e falha permanente já commitada (§9).

| Situação | HTTP | Corpo |
|---|---|---|
| Payload inválido, antes de persistir | 400 | `failureCode` `INVALID_PAYLOAD` ou `REFERENCE_REQUIRED` |
| Wallet duplicada | 409 | `WALLET_ALREADY_EXISTS` |
| Mesma key, outro hash | 409 | `IDEMPOTENCY_PAYLOAD_MISMATCH` |
| Par provider + external preso a outra key | 409 | `IDEMPOTENCY_KEY_MISMATCH` |
| Regra de negócio persistida como `REJECTED` | 422 | `transactionId`, `failureCode`, saldo observado quando a wallet existia |
| Wallet inexistente | 422 | `WALLET_NOT_FOUND`, sem campo de saldo |
| Referência ainda ausente | 202 | `PENDING_REFERENCE` e o snapshot gravado na aceitação |
| Aplicada, inclusive replay | 200 | `idempotentReplay` true ou false |
| Nada commitado: lock, deadlock, banco ou fila indisponíveis | 503 | sem status terminal |
| `FAILED` já commitado, inclusive replay | 500 | `PERSISTENT_STATE_CORRUPT` |
| Consulta inexistente | 404 | sem efeito financeiro |
| Abertura de wallet | 201 | conflito de player + moeda continua 409 |

O replay repete o status e os campos de negócio. Só `idempotentReplay` muda, e por isso o flag não é persistido. 409 não devolve o corpo de sucesso da linha antiga. `WALLET_NOT_FOUND` queima a key: corrigir o `walletId` muda o hash e passa a 409. A correção é outra idempotency key.

### D13 — Ambiente e três processos

PostgreSQL 16 e LocalStack com imagens pinadas no Compose. NestJS no adapter Express. O teste de concorrência sobe três ou mais processos Bun, com pids distintos, contra o mesmo banco e a mesma fila. Sem mock de PostgreSQL e sem mock de SQS (§13, §14). A carga dos três processos é aposta, reversão e outbox. Três health checks não provam a seção 8.

### D14 — FAILED sem evento novo

`FAILED` é terminal e auditável (§6.3). A lista mínima de eventos não inclui falha de infraestrutura (§11). Não existe `WagerTransactionFailed`. TTL e regra de negócio publicam `WagerTransactionRejected`.

`PERSISTENT_STATE_CORRUPT` fica para constraint que o código não sabe nomear, depois de reler o estado commitado. Unique de idempotência, unique de reversão, unique de lançamento e `CHECK` de teto não entram nesse ramo. Se o `CHECK` de saldo da wallet ou do ledger disparar, a transação nova grava `REJECTED` com `INSUFFICIENT_FUNDS` ou `REVERSAL_INSUFFICIENT_FUNDS`, conforme o kind.

A transação que escreve `FAILED` corre depois do rollback da transação que estourou a constraint. Ela não mexe em saldo nem em ledger. Mensagem cuja linha ficou `FAILED` recebe ack, incrementa métrica e não é reprocessada. Nack empurraria à DLQ um fato que já está no banco.

Payload que não forma o agregado não abre `wager_transactions` nem ledger. Na fila, a primeira leitura já é permanente: grava `ingress_rejects` (ids, hash quando existir, `failure_code`, instante; sem amount e sem corpo) e envia à DLQ. Não espera `maxReceiveCount`. HTTP inválido continua 400 sem linha financeira. Log de poison leva `messageId` e o motivo, sem corpo financeiro (§12). O produtor descobre `FAILED` pelo `GET`. Essa ausência de evento é limitação aceita do enunciado.

`OPENING` não passa por `SubmitWager`. Esse caso de uso aceita só `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`. `OpenWallet` cria `OPENING` na mesma transação SQL da abertura quando o saldo inicial é positivo (§9). A key interna usa o prefixo `internal:`, fora do espaço que o cliente pode escolher.

## Taxonomia de failureCode

| Código | Quando |
|---|---|
| `INVALID_PAYLOAD` | Contrato inválido, dinheiro inválido, escala, moeda, kind externo `OPENING`, referência presente em `BET` ou `LOSS` |
| `REFERENCE_REQUIRED` | `REFUND` ou `ROLLBACK` sem o campo de referência. HTTP 400, sem linha |
| `IDEMPOTENCY_PAYLOAD_MISMATCH` | Mesma key, hash diferente. HTTP 409, sem linha nova |
| `IDEMPOTENCY_KEY_MISMATCH` | O par provider + external já está preso a outra key |
| `WALLET_ALREADY_EXISTS` | Segunda wallet do mesmo player e moeda |
| `WALLET_NOT_FOUND` | Wallet inexistente, rejeição persistida |
| `WALLET_PLAYER_MISMATCH` | `walletId` não pertence ao `playerId` |
| `CURRENCY_MISMATCH` | Moeda da operação diferente da wallet |
| `INSUFFICIENT_FUNDS` | `BET` sem saldo |
| `REVERSAL_INSUFFICIENT_FUNDS` | Reversão de crédito deixaria saldo negativo |
| `AMOUNT_OVERFLOW` | Valor ou soma fora de `numeric(20,2)` |
| `REFERENCE_NOT_FOUND` | Prazo ou tentativas esgotados e a referência não existe |
| `REFERENCE_NOT_PROCESSED` | Referência existe e não está `PROCESSED` |
| `REFERENCE_KIND_NOT_ALLOWED` | Kind de referência fora da regra do §7 |
| `REFERENCE_SCOPE_MISMATCH` | Provider, player, wallet, moeda ou rodada divergentes |
| `AMOUNT_MISMATCH` | Valor diferente da referência |
| `REFERENCE_ALREADY_REVERSED` | Já existe reversão `PROCESSED` daquela referência |
| `PERSISTENT_STATE_CORRUPT` | Constraint não mapeada. Status `FAILED`. HTTP 500. Sem evento novo |

`PENDING_REFERENCE` é status, não `failureCode`.

## Schema proposto

Schema da migration `Migration20261029160100_Financial`.

### wallets

- PK `id` (UUIDv7)
- `player_id` não nulo
- `currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$')`
- `UNIQUE (player_id, currency)`
- `balance_amount numeric(20,2) NOT NULL CHECK (balance_amount >= 0)`
- `balance_currency varchar(3) NOT NULL` com o mesmo `CHECK` lexical e `CHECK (balance_currency = currency)`
- `version integer NOT NULL CHECK (version >= 1)`
- `created_at`, `updated_at`

### wager_transactions

- PK `id` (UUIDv7)
- `UNIQUE (idempotency_key)`
- `UNIQUE (provider_id, external_transaction_id)`
- `payload_hash` obrigatório
- `amount numeric(20,2) NOT NULL CHECK (amount > 0)`
- `currency varchar(3) NOT NULL` com o `CHECK` lexical
- `wallet_id` obrigatório, sem FK
- referência externa obrigatória por `CHECK` para `REFUND` e `ROLLBACK`
- `reference_transaction_id` nulo até a resolução
- `CHECK` de D7: `PROCESSED` e kind de reversão implicam `reference_transaction_id` não nulo
- snapshot `observed_balance_amount numeric(20,2)` e `observed_balance_currency varchar(3)`, ambos nulos ou ambos presentes
- `attempt_count`, `next_attempt_at`, `deadline_at` como em D11
- índice único parcial `ux_reversal_once`
- índice parcial das pendências: `status = 'PENDING_REFERENCE'`
- trigger de imutabilidade descrito em D8

### wallet_ledger_entries

- PK `id`
- `UNIQUE (transaction_id)`
- `amount numeric(20,2) NOT NULL CHECK (amount > 0)`
- moeda `varchar(3)` com o `CHECK` lexical, nas três colunas de valor
- `CHECK` aritmético de `CREDIT` e de `DEBIT`
- `CHECK (balance_before >= 0)` e `CHECK (balance_after >= 0)`
- sem `updated_at`
- trigger que recusa `UPDATE` e `DELETE`

### inbox_messages

- PK `(consumer_name, message_id)`
- `payload_hash`, `received_at`, `processed_at`

### outbox_messages

- PK = `eventId`
- `attempts`, `next_attempt_at`, `published_at`
- índice parcial `published_at IS NULL`

### ingress_rejects

Trilha de mensagem de fila que não vira transação financeira. Sem amount e sem corpo. Colunas: `id`, `consumer_name`, `message_id`, `payload_hash` nulo, `failure_code`, `received_at`.

Identificadores de agregado, transação e evento: UUIDv7. Cursor do ledger: keyset opaco e assinado sobre `(created_at, id)`, predicado sempre com `wallet_id`, parâmetros bind. Offset não entra.

## Migrations

Há três migrations versionadas. Nenhuma altera D1–D14.

A da fase 1 está em `src/persistence/migrations/Migration20261029143000_Empty.ts`. Sobe e desce com `select 1`. Não cria coluna de dinheiro.

`Migration20261029160000_AppRole` cria o papel `wager_app`. Fica fora de transação porque `CREATE ROLE` e `DROP ROLE` recusam bloco. O `down` revoga os privilégios e remove o papel. Não remove o papel enquanto existir sessão com ele.

`Migration20261029160100_Financial` cria o schema nesta ordem: `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages`, `outbox_messages`, `ingress_rejects`, índices parciais e, por último, os triggers. `down` remove os triggers, as funções, os índices e as tabelas na ordem inversa. Não há `UPDATE` de dados. O papel da aplicação não é dono das tabelas, para o trigger do ledger valer sobre ele. `TRUNCATE` não faz parte do papel da aplicação. As migrations confirmam uma a uma: o papel e o schema não compartilham a mesma transação.

## Observabilidade

Logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` (§12). Amount, corpo da aposta, corpo de SQS, parâmetros de SQL e stack com credencial ficam de fora. O log de query do MikroORM com parâmetros fica desligado fora de depuração local. O filtro de exceção tem allowlist de campos.

Métricas: transações por status, duplicatas, retries, mensagens na DLQ, conflitos de lock, outbox lag e latência de processamento.

`GET /health/live` responde se o processo está vivo. `GET /health/ready` consulta PostgreSQL e SQS. Nenhum dos dois exige autenticação.

## Fora desta entrega

Partidas dobradas, OpenTelemetry, dashboard, Identity Provider real e teste de carga. O ledger exigido é um lançamento por transação financeira. Carga, se for feita depois, entra como `bun run test:load`, com ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de lock e outbox lag. Não há meta de RPS.

## Limitações conhecidas

Nenhuma destas limitações altera D1–D14. Nenhuma foi classificada como bloqueio da correção financeira. O detalhe e a evidência estão em `docs/conformidade.md`.

- `57P03` (PostgreSQL em shutdown) não está na lista de erros transitórios. O worker que estava conectado morre. Um processo iniciado depois não duplica o débito já commitado.
- `ingress_rejects` não é única por `message_id`. Uma queda entre o insert e a DLQ pode gravar outra linha de auditoria, sem ledger.
- Duas resoluções de `PENDING_REFERENCE` podem regravar `attempt_count` se a segunda leitura não enxergar o incremento da primeira. O teste do lease subiu o contador e não gerou segundo crédito.
- A deduplicação por `eventId` persistido existe no consumidor de teste, não no processo da aplicação. A janela de cinco minutos do FIFO não é a garantia.
- O LocalStack deste Compose não tem volume. Um restart perde a mensagem já aceita pelo SQS. A outbox no PostgreSQL permanece.
- `AuthGuard` nas rotas financeiras é no-op, como a D2. Health continua aberto.
- As métricas do §12 ficam na memória do processo. Não há endpoint de exportação.

## Divergências em relação ao README

Estas dez leituras foram aprovadas e estão em vigor. O texto de D1–D14 não muda por causa delas.

| # | Texto do README | Decisão | Por quê |
|---|---|---|---|
| 1 | §7 regra 4: a referência não pode ser revertida duas vezes pelo mesmo tipo | D7: no máximo uma reversão `PROCESSED`, qualquer kind | `REFUND` e `ROLLBACK` da mesma `BET` creditam duas vezes e ferem §3. A frase final da §7 pede a interpretação documentada |
| 2 | §6.1 não lista escala menor que 2 como inválida | `"25"` e `"25.0"` viram `"25.00"` antes do hash. Mais de duas casas é rejeição | Sem uma regra única, o mesmo valor gera dois hashes (§9) |
| 3 | §6.1 pede ISO-4217 | `"brl"` é `INVALID_PAYLOAD`. Não há upper case silencioso | Upper case num lado só quebra o hash e o `CHECK` |
| 4 | §6.1 rejeita negativo e não fala de zero | `"0.00"` é `INVALID_PAYLOAD` nos kinds externos | O ledger exige `amount > 0`. Zero aceito viraria `FAILED` |
| 5 | §9: formato `{providerId}:{externalTransactionId}` é o default recomendado | A key é obrigatoriamente esse par, nos dois canais | Header e corpo deixam de ser duas identidades para um efeito |
| 6 | §7.1: o limite de espera é definido por nós | TTL operacional de 15 min; 3s só no teste. Visibility 60s e `maxReceiveCount` 5 | 2 min fica abaixo do horizonte de retry da `BET` e produz `REFERENCE_NOT_FOUND` falso |
| 7 | §6.3 `FAILED` é auditável. §9 pede separar falha transitória de falha permanente | Replay de `FAILED` é HTTP 500 | 503 convidaria retry eterno de uma key já terminal |
| 8 | O esqueleto não tem tabela de ingresso recusado | `ingress_rejects` guarda hash e código, sem corpo | A DLQ sozinha expira, e o log não pode levar o payload financeiro (§12) |
| 9 | Não há frase sobre FK de wallet | `wager_transactions.wallet_id` não tem FK | `WALLET_NOT_FOUND` precisa persistir o id pedido |
| 10 | §7 não fala em reabrir vaga | `ROLLBACK` de `REFUND` não libera a `BET` para outro `REFUND` | O `REFUND` permanece `PROCESSED`. Reabrir a vaga recriaria o crédito duplo da divergência 1 |

Não são divergência, e ficam explícitas para o teste não inventar regra: `ROLLBACK` de `WIN` e `REFUND` da `BET` podem os dois ser `PROCESSED`. Várias `WIN` podem referenciar a mesma `BET`. Não há invariante de rodada no enunciado.
