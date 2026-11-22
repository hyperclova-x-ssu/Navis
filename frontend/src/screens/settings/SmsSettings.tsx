import { useState } from 'react';
import { accountHostFor } from '../../app/account-host';
import type { Locale, RunStore, ShopSettings } from '../../contracts';
import { ActionButton, SettingRow } from '../../ui';

const labels = {
  ko: { sender: '문자 발신번호', optOut: '무료 수신거부 번호', save: '문자 설정 저장하기', invalid: '등록된 발신번호와 080 번호를 확인해 주세요.', failure: '문자 설정을 저장할 수 없어요.', saved: '문자 설정을 저장했어요.' },
  en: { sender: 'SMS sender number', optOut: 'Free opt-out number', save: 'Save SMS settings', invalid: 'Check your registered sender and 080 numbers.', failure: 'The SMS settings could not be saved.', saved: 'SMS settings saved.' },
  'zh-Hans': { sender: '短信发送号码', optOut: '免费退订号码', save: '保存短信设置', invalid: '请检查已注册的发送号码和 080 号码。', failure: '无法保存短信设置。', saved: '已保存短信设置。' },
  'zh-Hant': { sender: '簡訊發送號碼', optOut: '免費退訂號碼', save: '儲存簡訊設定', invalid: '請檢查已註冊的發送號碼和 080 號碼。', failure: '無法儲存簡訊設定。', saved: '已儲存簡訊設定。' },
};

type SmsSettings = NonNullable<ShopSettings['smsSettings']>;

export function SmsSettingsForm({ run, interactive, locale, current, apply }: {
  run: RunStore; interactive: boolean; locale: Locale; current: SmsSettings; apply: (settings: SmsSettings) => boolean;
}) {
  const [sender, setSender] = useState(current.senderNumber ?? '');
  const [optOut, setOptOut] = useState(current.optOutNumber ?? '');
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<'invalid' | 'failure' | 'saved'>();
  const t = labels[locale];
  return <form className="settings-sms" onSubmit={async event => {
    event.preventDefault();
    if (!interactive || pending) return;
    const senderNumber = sender.trim().replace(/[ -]/g, '') || null;
    const optOutNumber = optOut.trim().replace(/[ -]/g, '') || null;
    if (senderNumber && !/^[0-9]{8,11}$/.test(senderNumber) || optOutNumber && !/^080[0-9]{7,8}$/.test(optOutNumber)) {
      setStatus('invalid');
      return;
    }
    const host = accountHostFor(run);
    setStatus(undefined);
    setPending(true);
    try {
      const result = host && apply({ senderNumber, optOutNumber }) && await host.flush();
      setStatus(result === 'saved' || result === 'unchanged' ? 'saved' : 'failure');
    } catch { setStatus('failure'); }
    finally { setPending(false); }
  }}>
    <SettingRow><label>{t.sender} <input type="tel" maxLength={20} value={sender} disabled={!interactive || pending}
      onChange={event => setSender(event.currentTarget.value)} /></label></SettingRow>
    <SettingRow><label>{t.optOut} <input type="tel" maxLength={20} value={optOut} disabled={!interactive || pending}
      onChange={event => setOptOut(event.currentTarget.value)} /></label></SettingRow>
    <ActionButton type="submit" variant="secondary" disabled={!interactive || pending}>{t.save}</ActionButton>
    {status && <p role={status === 'saved' ? 'status' : 'alert'}>{t[status]}</p>}
  </form>;
}
