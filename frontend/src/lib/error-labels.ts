export const ERROR_LABELS: Record<string, string> = {
  token_invalid: 'Токен невалиден или протух',
  proxy_unreachable: 'Прокси не отвечает',
  proxy_auth_failed: 'Прокси: неверный логин/пароль',
  twitch_unreachable: 'Twitch недоступен',
  chat_blocked: 'Аккаунт заблокирован в чате',
  join_failed: 'Не удалось войти в канал',
  timeout: 'Превышено время ожидания',
  unknown: 'Неизвестная ошибка',
  bulk_running: 'Идёт bulk-send, подожди завершения',
  unknown_account: 'Аккаунт не найден',
  empty_message: 'Введи сообщение',
  no_channel: 'В Settings не задан канал',
  stopped: 'Остановлен',
  not_running: 'Рассылка не идёт'
};

export const STAGE_LABELS: Record<string, string> = {
  connecting: 'подключение',
  auth: 'авторизация',
  join: 'вход в канал',
  sent: 'отправлено',
  waiting: 'подтверждение'
};

export const errLabel = (code?: string) =>
  code ? (ERROR_LABELS[code] ?? code) : '';
