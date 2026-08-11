// apps/api/src/modules/auth/otp/otp-sender.interface.ts
export interface OtpSender {
  send(destination: string, code: string): Promise<void>;
}

export const OTP_SENDER = Symbol('OTP_SENDER');
