/* What the ZCode host says on its own account (its own actions: the library folder, the model endpoint, opening links),
   in the panel's language. Errors from a model call inside StudyHub's work go through lib/application-messages.js like
   every other application message, because the work does not know the panel's language. {0}, {1}… are parameters;
   a parameter that is itself a code here (a reason) is put into words in the same language. */

const TEXT = Object.freeze({
  'library-not-absolute': ['请填写学习库的完整路径（例如 D:\\StudyHub）', 'Enter the full path of the library folder (for example D:\\StudyHub)'],
  'library-unusable': ['这个位置不能用作学习库：{0}', 'This location cannot be used as a library: {0}'],
  'library-fallback': ['学习库「{0}」打不开（{1}），这次先用「{2}」。请在「设置 › 学习库与模型」换一个能写入的文件夹。',
    'The library "{0}" could not be opened ({1}); "{2}" is used for now. Choose a folder that can be written in Settings › Library & model.'],
  'reason-missing': ['找不到这个盘或上级文件夹', 'the drive or a parent folder does not exist'],
  'reason-denied': ['没有在这里写入的权限', 'there is no permission to write there'],
  'reason-read-only': ['这个位置是只读的', 'the location is read-only'],
  'reason-not-folder': ['这里已经有一个同名的文件', 'a file with that name is already there'],
  'reason-not-absolute': ['不是完整路径', 'it is not a full path'],
  'reason-error': ['系统报错 {0}', 'the system reported {0}'],
  'model-url-invalid': ['接口地址不是一个网址，请以 https:// 开头', 'The address is not a web address; start it with https://'],
  'model-key-invalid': ['API Key 只能是一串不含空格的英文字母、数字和符号，请重新复制', 'An API key is one string of letters, digits and symbols without spaces; copy it again'],
  'model-incomplete': ['还缺接口地址、模型或 API Key，填好保存后再测试', 'The address, the model or the API key is missing; fill them in and save, then test'],
  'model-test-ok': ['可用：接口、模型和密钥都通了', 'Works: the address, the model and the key all answered'],
  'link-refused': ['只能打开正常的 http(s) 网址', 'Only an ordinary http(s) web address can be opened'],
  'update-no-installer': ['ZCode 版不能在应用内升级，请按升级说明下载新的 ZCode 安装包', 'The ZCode edition cannot upgrade itself; download the new ZCode package as the upgrade steps say'],
  'panel-open-unavailable': ['ZCode 版的面板不能被主会话打开题目；请让学习者在面板里点开', 'In ZCode the chat cannot open a question in the panel; ask the learner to open it there'],
  'panel-only': ['这个操作只能在 StudyHub 面板里由学习者自己做', 'Only the learner can do this, in the StudyHub panel'],
  'panel-stale': ['StudyHub 的服务已经重新启动，请关掉这个面板再重新打开', 'StudyHub\'s service has restarted; close this panel and open it again'],
});

/** The words of a reason code ('missing', 'denied', … or 'error:EBUSY'). */
export function reasonText(reason, language = 'zh') {
  const [code, detail] = String(reason || '').split(':');
  if (code === 'error') return zcodeText('reason-error', language, [detail || 'unknown']);
  return TEXT[`reason-${code}`] ? zcodeText(`reason-${code}`, language) : String(reason);
}

export const zcodeText = (code, language = 'zh', params = []) => {
  const pair = TEXT[code];
  if (!pair) return code;
  const template = pair[language === 'en' ? 1 : 0];
  return template.replace(/\{(\d)\}/g, (_match, index) => {
    const value = params[Number(index)];
    return code === 'library-unusable' || (code === 'library-fallback' && index === '1') ? reasonText(value, language) : String(value ?? '');
  });
};

/** An error that carries its code (and parameters); the host turns it into words in the panel's language. */
export const zcodeError = (code, params = []) => Object.assign(new Error(zcodeText(code, 'zh', params)), { code: `zcode-${code}`, params });

/** The words of an error from this host in `language`; other errors keep their own message. */
export const zcodeErrorText = (error, language) => (typeof error?.code === 'string' && error.code.startsWith('zcode-')
  ? zcodeText(error.code.slice(6), language, error.params || []) : String(error?.message ?? error));

export const ZCODE_MESSAGE_CODES = Object.freeze(Object.keys(TEXT));
