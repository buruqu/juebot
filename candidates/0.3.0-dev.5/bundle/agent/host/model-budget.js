import { randomUUID } from 'node:crypto';
import { AgentError, stable } from '../lib/agent-v1/src/common.js';

const need = (ok, code = 'MODEL_BUDGET_INVALID') => { if (!ok) throw new AgentError(code); };
const uint = value => Number.isSafeInteger(value) && value >= 0;
const dayKey = day => 'model-budget:utc:' + day;
const ticketKey = id => 'model-budget:reservation:' + id;
function usageUnits(value) {
  if (value === null) return null;
  need(value && ['prompt_tokens', 'completion_tokens', 'total_tokens'].every(key => uint(value[key])));
  need(Number.isSafeInteger(value.prompt_tokens + value.completion_tokens) && value.total_tokens === value.prompt_tokens + value.completion_tokens);
  return value.total_tokens;
}
function dayState(row) {
  const value = row?.value ?? { chargedUnits: 0, reservedUnits: 0, settledUnits: 0, reservations: 0 };
  need(['chargedUnits', 'reservedUnits', 'settledUnits', 'reservations'].every(key => uint(value[key]))
    && value.chargedUnits === value.reservedUnits + value.settledUnits, 'MODEL_BUDGET_STATE_INVALID');
  return value;
}

/** Namespace-wide UTC unit ledger, shared across models/personas. Units are NOT
 * currency or a token-price estimate. Pending/uncertain reservations remain
 * charged forever on their original day; this class never prunes or refunds
 * them on startup, model changes, timeout, or UTC rollover. Caller owns store. */
export class ModelBudget {
  #store; #dailyUnits; #now;
  constructor(store, { dailyUnits, now = Date.now }) {
    need(store && typeof store.atomic === 'function' && typeof store.read === 'function');
    need(uint(dailyUnits) && dailyUnits > 0 && typeof now === 'function');
    this.#store = store; this.#dailyUnits = dailyUnits; this.#now = now;
  }
  #day() {
    const now = this.#now(); need(uint(now) && now <= 253402300799999);
    return new Date(now).toISOString().slice(0, 10);
  }
  reserve(units) {
    need(uint(units) && units > 0);
    const day = this.#day(); const id = randomUUID();
    return this.#store.atomic(tx => {
      const row = tx.read(dayKey(day)); const value = dayState(row);
      need(units <= this.#dailyUnits && value.chargedUnits <= this.#dailyUnits - units, 'MODEL_BUDGET_DENIED');
      need(uint(value.reservations + 1));
      const ticket = { id, day, units };
      tx.write(ticketKey(id), 0, { ...ticket, status: 'reserved', settlement: null });
      tx.write(dayKey(day), row?.revision ?? 0, { chargedUnits: value.chargedUnits + units,
        reservedUnits: value.reservedUnits + units, settledUnits: value.settledUnits, reservations: value.reservations + 1 });
      return ticket;
    });
  }
  settle(ticket, { usage, uncertain }) {
    need(ticket && typeof ticket.id === 'string' && /^[0-9a-f-]{36}$/u.test(ticket.id)
      && typeof ticket.day === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(ticket.day) && uint(ticket.units) && ticket.units > 0);
    need(typeof uncertain === 'boolean'); const actual = usageUnits(usage);
    need(uncertain || actual !== null);
    const charged = uncertain ? Math.max(ticket.units, actual ?? 0) : actual;
    const settlement = { usage, uncertain, chargedUnits: charged };
    return this.#store.atomic(tx => {
      const row = tx.read(ticketKey(ticket.id)); const saved = row?.value;
      need(saved && saved.id === ticket.id && saved.day === ticket.day && saved.units === ticket.units, 'MODEL_BUDGET_TICKET_INVALID');
      if (saved.status === 'settled') {
        need(stable(saved.settlement) === stable(settlement), 'MODEL_BUDGET_SETTLEMENT_CONFLICT');
        return saved.settlement;
      }
      need(saved.status === 'reserved', 'MODEL_BUDGET_STATE_INVALID');
      const dayRow = tx.read(dayKey(saved.day)); need(dayRow, 'MODEL_BUDGET_STATE_INVALID');
      const value = dayState(dayRow); need(value.reservedUnits >= saved.units, 'MODEL_BUDGET_STATE_INVALID');
      const settledUnits = value.settledUnits + charged;
      const reservedUnits = value.reservedUnits - saved.units;
      need(uint(settledUnits) && uint(reservedUnits + settledUnits), 'MODEL_BUDGET_STATE_INVALID');
      tx.write(ticketKey(ticket.id), row.revision, { ...saved, status: 'settled', settlement });
      tx.write(dayKey(saved.day), dayRow.revision, { ...value, chargedUnits: reservedUnits + settledUnits, reservedUnits, settledUnits });
      return settlement;
    });
  }
  snapshot(day = this.#day()) {
    need(typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(day));
    return { day, dailyUnits: this.#dailyUnits, ...dayState(this.#store.read(dayKey(day))) };
  }
}
