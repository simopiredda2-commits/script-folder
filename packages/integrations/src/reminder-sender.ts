/**
 * Consegna del promemoria per canali alternativi alla carta: email con il promemoria allegato,
 * SMS con il numero di ricetta (DM 30 dicembre 2020, art. 3, e Ordinanza 651/2020 richiamata lì).
 * Qui solo l'interfaccia e il simulatore: il fornitore vero di posta e SMS si sceglierà con le
 * garanzie sul trattamento dei dati (regola 7: nessuna chiamata a servizi reali).
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  attachments: { filename: string; contentType: string; content: Uint8Array }[];
}

export interface SmsMessage {
  to: string;
  text: string;
}

export type DeliveryResult =
  | { outcome: 'sent'; messageId: string }
  | { outcome: 'rejected'; message: string }
  | { outcome: 'unreachable'; message: string };

export interface ReminderSender {
  readonly environment: 'simulator' | 'test' | 'production';
  sendEmail(message: EmailMessage): Promise<DeliveryResult>;
  sendSms(message: SmsMessage): Promise<DeliveryResult>;
}

export interface ReminderSenderOptions {
  /** Esito di ogni consegna. Per difetto: consegnata. */
  decide?: (channel: 'email' | 'sms', to: string) => DeliveryResult['outcome'];
}

/** Simulatore: tiene i messaggi in memoria, per le prove; niente esce davvero. */
export class SimulatedReminderSender implements ReminderSender {
  readonly environment = 'simulator' as const;
  readonly emails: EmailMessage[] = [];
  readonly sms: SmsMessage[] = [];
  private counter = 0;

  constructor(private readonly options: ReminderSenderOptions = {}) {}

  sendEmail(message: EmailMessage): Promise<DeliveryResult> {
    return Promise.resolve(this.deliver('email', message.to, () => this.emails.push(message)));
  }

  sendSms(message: SmsMessage): Promise<DeliveryResult> {
    return Promise.resolve(this.deliver('sms', message.to, () => this.sms.push(message)));
  }

  private deliver(channel: 'email' | 'sms', to: string, keep: () => void): DeliveryResult {
    const outcome = this.options.decide?.(channel, to) ?? 'sent';
    if (outcome === 'rejected')
      return { outcome, message: `Simulatore: recapito ${to} rifiutato per prova` };
    if (outcome === 'unreachable')
      return { outcome, message: 'Servizio di invio non raggiungibile (simulato)' };
    keep();
    this.counter += 1;
    return { outcome: 'sent', messageId: `SIM-${channel}-${this.counter}` };
  }
}
