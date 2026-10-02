import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

/** Échappe le texte inséré dans les modèles HTML (nom saisi par l'utilisateur...) */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * E-mails transactionnels Voyagooo via Resend (RESEND_API_KEY).
 * Sans clé (développement), le contenu utile est écrit dans les logs au lieu d'être envoyé.
 * Expéditeur : MAIL_FROM (domaine à vérifier dans Resend).
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend: Resend | null;
  private readonly from: string;

  constructor(configService: ConfigService) {
    const key = configService.get<string>('RESEND_API_KEY');
    this.resend = key ? new Resend(key) : null;
    this.from = configService.get<string>('MAIL_FROM') || 'Voyagooo <noreply@voyagooo.com>';
    if (!this.resend) {
      this.logger.warn('RESEND_API_KEY absente : les e-mails sont écrits dans les logs');
    }
  }

  /** Envoie un e-mail ; renvoie false en cas d'échec (jamais d'exception). */
  private async send(to: string, subject: string, html: string, text: string, devLog: string): Promise<boolean> {
    if (!this.resend) {
      this.logger.log(`[DEV] ${subject} → ${to} : ${devLog}`);
      return true;
    }
    try {
      const { error } = await this.resend.emails.send({ from: this.from, to, subject, html, text });
      if (error) {
        this.logger.error(`Resend a refusé l'e-mail « ${subject} » pour ${to} : ${error.message}`);
        return false;
      }
      return true;
    } catch (err: any) {
      this.logger.error(`Échec d'envoi de l'e-mail « ${subject} » pour ${to} : ${err.message}`);
      return false;
    }
  }

  /** Mise en page commune : en-tête Voyagooo, contenu, pied de page. */
  private layout(title: string, body: string): string {
    return `<!doctype html>
<html lang="fr"><body style="margin:0;padding:0;background:#0F1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0F1117;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#1A1D27;border-radius:20px;overflow:hidden;border:1px solid #2A2D3A;">
        <tr><td style="padding:28px 32px 8px 32px;">
          <div style="font-size:22px;font-weight:800;color:#FFFFFF;">🦜 Voyagooo</div>
        </td></tr>
        <tr><td style="padding:8px 32px 0 32px;">
          <h1 style="margin:16px 0 8px 0;font-size:22px;line-height:1.3;color:#FFFFFF;">${title}</h1>
        </td></tr>
        <tr><td style="padding:0 32px 28px 32px;color:#C9CBD6;font-size:15px;line-height:1.6;">${body}</td></tr>
      </table>
      <p style="color:#6B6E7E;font-size:12px;margin:18px 0 0 0;">Voyagooo · Planifie, explore, collectionne tes voyages</p>
    </td></tr>
  </table>
</body></html>`;
  }

  private codeBlock(code: string): string {
    return `<div style="margin:24px 0;padding:20px;background:#0F1117;border:1px solid #2A2D3A;border-radius:14px;text-align:center;">
      <span style="font-size:34px;font-weight:800;letter-spacing:10px;color:#58CC02;font-family:'SF Mono',Menlo,Consolas,monospace;">${code}</span>
    </div>`;
  }

  async sendEmailVerificationCode(to: string, name: string | undefined, code: string, expiresInMinutes: number) {
    const hello = name ? `Bonjour ${escapeHtml(name)},` : 'Bonjour,';
    return this.send(
      to,
      `${code} est ton code de vérification Voyagooo`,
      this.layout(
        'Vérifie ton adresse e-mail ✉️',
        `<p>${hello}</p>
         <p>Saisis ce code dans l'application pour confirmer ton adresse e-mail et sécuriser ton compte :</p>
         ${this.codeBlock(code)}
         <p>Ce code est valable <strong style="color:#FFFFFF;">${expiresInMinutes} minutes</strong>.</p>
         <p style="color:#8A8A9B;font-size:13px;">Tu n'as pas créé de compte Voyagooo ? Ignore simplement cet e-mail.</p>`,
      ),
      `${hello}\n\nTon code de vérification Voyagooo : ${code}\nValable ${expiresInMinutes} minutes.\n\nTu n'as pas créé de compte ? Ignore cet e-mail.`,
      `code ${code}`,
    );
  }

  async sendPasswordResetCode(to: string, name: string | undefined, code: string, expiresInMinutes: number) {
    const hello = name ? `Bonjour ${escapeHtml(name)},` : 'Bonjour,';
    return this.send(
      to,
      `${code} est ton code de réinitialisation Voyagooo`,
      this.layout(
        'Réinitialise ton mot de passe 🔑',
        `<p>${hello}</p>
         <p>Tu as demandé à réinitialiser ton mot de passe. Saisis ce code dans l'application :</p>
         ${this.codeBlock(code)}
         <p>Ce code est valable <strong style="color:#FFFFFF;">${expiresInMinutes} minutes</strong>.</p>
         <p style="color:#8A8A9B;font-size:13px;">Tu n'es pas à l'origine de cette demande ? Ignore cet e-mail : ton mot de passe reste inchangé.</p>`,
      ),
      `${hello}\n\nTon code de réinitialisation Voyagooo : ${code}\nValable ${expiresInMinutes} minutes.\n\nTu n'es pas à l'origine de cette demande ? Ignore cet e-mail.`,
      `code ${code}`,
    );
  }

  /** Alerte de sécurité après un changement de mot de passe. */
  async sendPasswordChanged(to: string, name: string | undefined) {
    const hello = name ? `Bonjour ${escapeHtml(name)},` : 'Bonjour,';
    return this.send(
      to,
      'Ton mot de passe Voyagooo a été modifié',
      this.layout(
        'Mot de passe modifié ✅',
        `<p>${hello}</p>
         <p>Le mot de passe de ton compte Voyagooo vient d'être modifié. Par sécurité, tu as été déconnecté de tes autres appareils.</p>
         <p style="color:#8A8A9B;font-size:13px;">Ce n'était pas toi ? Utilise immédiatement « Mot de passe oublié » dans l'application pour reprendre la main sur ton compte.</p>`,
      ),
      `${hello}\n\nLe mot de passe de ton compte Voyagooo vient d'être modifié. Ce n'était pas toi ? Utilise « Mot de passe oublié » dans l'application.`,
      'mot de passe modifié',
    );
  }
}
