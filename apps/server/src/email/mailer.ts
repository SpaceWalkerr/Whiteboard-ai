import type { Logger } from "pino";
import { Resend } from "resend";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

/** Development: prints the email (including links) to the server log instead of sending it. */
export class LogMailer implements Mailer {
  constructor(private readonly logger: Logger) {}

  send(message: EmailMessage): Promise<void> {
    this.logger.info(
      { to: message.to, subject: message.subject, text: message.text },
      "email (log transport, not sent)",
    );
    return Promise.resolve();
  }
}

/** Tests: keeps sent emails in memory. */
export class MemoryMailer implements Mailer {
  readonly sent: EmailMessage[] = [];

  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

export class ResendMailer implements Mailer {
  private readonly client: Resend;

  constructor(
    apiKey: string,
    private readonly from: string,
  ) {
    this.client = new Resend(apiKey);
  }

  async send(message: EmailMessage): Promise<void> {
    const { error } = await this.client.emails.send({ from: this.from, ...message });
    if (error) throw new Error(`Resend rejected the email: ${error.name}`);
  }
}
