import { WAHAEvents } from '../structures/enums.dto';
import { WebhookConfig } from '../structures/webhooks.config.dto';
import { WAHAWebhook } from '../structures/webhooks.dto';
import { VERSION } from '../version';
import { WAHAInternalEvent, WhatsappSession } from './abc/session.abc';
import { WebhookConductor, WebhookSender } from './abc/webhooks.abc';
import request = require('request');
import { LoggerBuilder } from '@waha/utils/logging';
import { Logger } from 'pino';

export class WebhookSenderCore extends WebhookSender {
  send(json) {
    this.logger.info({ url: this.url }, `Sending POST ...`);
    this.logger.debug({ data: json }, `POST DATA`);

    request.post(this.url, { json: json }, (error, res, body) => {
      if (error) {
        this.logger.error(error);
        return;
      }
      this.logger.info(
        `POST request was sent with status code: ${res.statusCode}`,
      );
      this.logger.debug({ body: body }, `Response`);
    });
  }
}

export class WebhookConductorCore implements WebhookConductor {
  private logger: Logger;

  constructor(protected loggerBuilder: LoggerBuilder) {
    this.logger = loggerBuilder.child({ name: WebhookConductor.name });
  }

  protected buildSender(webhookConfig: WebhookConfig): WebhookSender {
    return new WebhookSenderCore(this.loggerBuilder, webhookConfig);
  }

  private getSuitableEvents(events: WAHAEvents[] | string[]): WAHAEvents[] {
    const allEvents = Object.values(WAHAEvents);

    // Enable all events if * in the events
    // @ts-ignore
    if (events.includes('*')) {
      return allEvents;
    }

    // Get only known events, log and ignore others
    const rightEvents = [];
    for (const event of events) {
      // @ts-ignore
      if (!allEvents.includes(event)) {
        this.logger.error(`Unknown event for webhook: '${event}'`);
        continue;
      }
      rightEvents.push(event);
    }
    return rightEvents;
  }

  public configure(session: WhatsappSession, webhooks: WebhookConfig[]) {
    for (const webhookConfig of webhooks) {
      this.configureSingleWebhook(session, webhookConfig);
    }
  }

  private configureSingleWebhook(
    session: WhatsappSession,
    webhook: WebhookConfig,
  ) {
    if (!webhook || !webhook.url || webhook.events.length === 0) {
      return;
    }

    const url = webhook.url;
    this.logger.info(`Configuring webhooks for ${url}...`);
    const events = this.getSuitableEvents(webhook.events);
    const sender = this.buildSender(webhook);
    for (const event of events) {
      const found = this.configureSingleEvent(
        session.subscribeSessionEvent,
        session,
        event,
        sender,
        url,
      );

      if (!found) {
        // Postpone for ENGINE_START event and configure engine events
        session.events.on(WAHAInternalEvent.ENGINE_START, () => {
          const found = this.configureSingleEvent(
            session.subscribeEngineEvent,
            session,
            event,
            sender,
            url,
          );
          if (!found) {
            this.logger.error(
              `Engine does not support webhook event: '${event}' for url '${url}'`,
            );
          }
        });
      }
    }
    this.logger.info(`Webhooks were configured for ${url}.`);
  }

  private configureSingleEvent(
    subscribeMethod,
    session: WhatsappSession,
    event: WAHAEvents,
    sender: WebhookSender,
    url: string,
  ) {
    const found = subscribeMethod.apply(session, [
      event,
      (data: any) => this.callWebhook(event, session, data, sender),
    ]);
    if (!found) {
      return false;
    }
    this.logger.info(`Event '${event}' is enabled for url: ${url}`);
    return true;
  }

  public async callWebhook(
    event,
    session: WhatsappSession,
    data: any,
    sender: WebhookSender,
  ) {
    const me = session.getSessionMeInfo();
    const json: WAHAWebhook = {
      event: event,
      session: session.name,
      metadata: session.sessionConfig?.metadata,
      me: me,
      payload: data,
      engine: session.engine,
      environment: VERSION,
    };
    sender.send(json);
  }
}
