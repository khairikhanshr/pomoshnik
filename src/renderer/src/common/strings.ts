// Every user-facing string of the main window and the overlay.
import type { AssistantPhase, PermissionKind, PermissionState, ToolStatus } from '@shared/types'

export const S = {
  app: {
    name: 'Джарвис',
    logo: 'J.A.R.V.I.S.',
    tagline: 'Голосовой ИИ-ассистент',
    loading: 'Запуск систем…',
    noBridge: 'Не удалось подключиться к ядру приложения. Перезапустите Джарвис.'
  },

  common: {
    close: 'Закрыть',
    cancel: 'Отмена',
    save: 'Сохранить',
    delete: 'Удалить',
    rename: 'Переименовать',
    copy: 'Копировать',
    copied: 'Скопировано',
    retry: 'Повторить',
    refresh: 'Обновить',
    unknownError: 'Неизвестная ошибка'
  },

  sidebar: {
    newChat: 'Новый чат',
    search: 'Поиск по чатам',
    clearSearch: 'Очистить поиск',
    groups: {
      pinned: 'Закреплённые',
      today: 'Сегодня',
      yesterday: 'Вчера',
      week: 'Последние 7 дней',
      earlier: 'Ранее',
      results: 'Результаты поиска'
    },
    nothingFound: 'Ничего не найдено',
    emptyTitle: 'Здесь появятся ваши чаты',
    emptyHint: 'Напишите сообщение или скажите «Джарвис».',
    voiceChat: 'Голосовой чат',
    renameLabel: 'Новое название чата',
    deleteTitle: 'Удалить чат?',
    deleteText: (title: string) => `Чат «${title}» и его вложения будут удалены без возможности восстановления.`,
    deleted: 'Чат удалён',
    settings: 'Настройки',
    wakeOn: (phrase: string) => `Слушаю «${phrase}»`,
    wakeStarting: 'Запуск микрофона…',
    wakeOff: 'Выключено',
    wakeFailed: 'Микрофон недоступен',
    wakeTurnOn: 'Включить голосовую активацию',
    wakeTurnOff: 'Выключить голосовую активацию'
  },

  header: {
    untitled: 'Новый чат',
    editTitle: 'Нажмите, чтобы переименовать',
    titleInput: 'Название чата',
    tierGroup: 'Модель ответа',
    speakOn: 'Озвучивать все ответы: включено',
    speakOff: 'Озвучивать все ответы: выключено'
  },

  messages: {
    you: 'Вы',
    jarvis: 'Джарвис',
    thinking: 'Думаю…',
    cancelled: 'Ответ остановлен',
    errorTitle: 'Не удалось получить ответ',
    copy: 'Копировать ответ',
    copyUser: 'Копировать сообщение',
    speak: 'Озвучить',
    stopSpeaking: 'Остановить озвучку',
    scrollDown: 'К последнему сообщению',
    copyCode: 'Копировать код',
    code: 'код',
    imageLink: 'Изображение',
    loadFailed: 'Не удалось загрузить чат',
    speakingNow: 'Джарвис говорит…',
    voiceRequest: 'Голосовой запрос',
    listLabel: 'Сообщения чата'
  },

  tools: {
    status: {
      running: 'Выполняется',
      ok: 'Готово',
      error: 'Ошибка',
      denied: 'Отклонено'
    } satisfies Record<ToolStatus, string>,
    args: 'Параметры',
    result: 'Результат',
    duration: (seconds: string) => `${seconds} с`
  },

  images: {
    screenshot: 'Снимок экрана',
    upload: 'Изображение',
    open: 'Открыть изображение',
    lightbox: 'Просмотр изображения',
    prev: 'Предыдущее изображение',
    next: 'Следующее изображение',
    counter: (i: number, n: number) => `${i} из ${n}`
  },

  composer: {
    placeholder: 'Спросите Джарвиса…',
    placeholderNoKey: 'Сначала добавьте API-ключ OpenAI',
    hint: 'Enter — отправить, Shift+Enter — новая строка',
    send: 'Отправить',
    stop: 'Остановить ответ',
    attach: 'Прикрепить изображение',
    screenshot: 'Скриншот',
    screenshotTitle: 'Прикрепить снимок текущего экрана',
    capturing: 'Снимаю экран…',
    dictate: 'Диктовка',
    dictateStop: 'Готово — распознать',
    dictateCancel: 'Отменить запись',
    recording: 'Запись',
    transcribing: 'Распознаю речь…',
    removeAttachment: 'Убрать вложение',
    dropHere: 'Отпустите, чтобы прикрепить изображение',
    onlyImages: 'Можно прикреплять только изображения',
    attachFailed: 'Не удалось прикрепить изображение',
    captureFailed: 'Не удалось сделать снимок экрана',
    micDenied: 'Нет доступа к микрофону. Разрешите его в настройках системы.',
    dictationFailed: 'Не удалось распознать речь',
    nothingRecognized: 'Речь не распознана',
    sendFailed: 'Не удалось отправить сообщение',
    noKeyAction: 'Добавить ключ'
  },

  empty: {
    greeting: (hour: number, title: string) => {
      const part =
        hour >= 5 && hour < 12
          ? 'Доброе утро'
          : hour >= 12 && hour < 18
            ? 'Добрый день'
            : hour >= 18 && hour < 23
              ? 'Добрый вечер'
              : 'Доброй ночи'
      return title ? `${part}, ${title}.` : `${part}.`
    },
    subtitle: 'Чем могу помочь? Напишите сообщение или скажите «Джарвис».',
    subtitleNoWake: 'Чем могу помочь? Напишите сообщение или нажмите на сферу и скажите команду.',
    orbHint: 'Нажмите на сферу, чтобы сказать команду голосом',
    examplesTitle: 'Попробуйте',
    examples: [
      'Сделай скриншот и ответь на вопросы теста',
      'Открой Telegram',
      'Какая погода сейчас в Алматы?',
      'Поставь напоминание через 10 минут'
    ]
  },

  onboarding: {
    title: 'Добро пожаловать',
    text: 'Я — Джарвис, ваш голосовой ассистент. Чтобы я мог отвечать и управлять компьютером, нужен API-ключ OpenAI.',
    step1: 'Создайте ключ на platform.openai.com',
    step2: 'Вставьте его ниже — он хранится зашифрованным только на этом компьютере',
    step3: 'Скажите «Джарвис» или напишите сообщение',
    keyLabel: 'API-ключ OpenAI',
    keyPlaceholder: 'sk-…',
    saveKey: 'Сохранить ключ',
    getKey: 'Получить ключ',
    allSettings: 'Все настройки ИИ',
    keySaved: 'Ключ сохранён. Системы готовы, сэр.',
    keysUrl: 'https://platform.openai.com/api-keys'
  },

  tiers: {
    resolved: (model: string) => `Модель: ${model}`
  },

  settings: {
    title: 'Настройки',
    back: 'К чатам',
    tabs: {
      ai: 'ИИ',
      voice: 'Голос',
      activation: 'Активация',
      computer: 'Управление ПК',
      general: 'Общие',
      about: 'О программе'
    },

    ai: {
      keySection: 'Подключение к OpenAI',
      keyLabel: 'API-ключ',
      keyDesc: 'Ключ хранится в зашифрованном виде и никогда не покидает основной процесс приложения.',
      keyPlaceholder: 'Вставьте ключ sk-…',
      keyPlaceholderReplace: 'Вставьте новый ключ, чтобы заменить',
      keyStored: (hint: string) => `Сохранён ключ ${hint}`,
      keyNone: 'Ключ не задан',
      keySaved: 'API-ключ сохранён',
      keyRemoved: 'API-ключ удалён',
      removeKey: 'Удалить ключ',
      showKey: 'Показать ключ',
      hideKey: 'Скрыть ключ',
      test: 'Проверить',
      testRow: 'Проверка подключения',
      testRowDesc: 'Короткий запрос к API с текущим ключом и адресом.',
      testing: 'Проверяю…',
      baseUrl: 'Адрес API',
      baseUrlDesc: 'Оставьте стандартный адрес OpenAI или укажите совместимый прокси.',
      baseUrlReset: 'Стандартный адрес',
      apiMode: 'Режим API',
      apiModeResponses: 'Responses API (рекомендуется)',
      apiModeChat: 'Chat Completions (для прокси)',
      tiersSection: 'Модели',
      tiersDesc: 'Luna, Terra и Sol — уровни моделей. «Авто» выбирает новейшую доступную вашему ключу модель уровня.',
      model: 'Модель',
      modelAuto: 'Авто (новейшая)',
      modelCustom: 'Другая модель…',
      modelCustomPlaceholder: 'Идентификатор модели, например gpt-6-sol',
      modelsTierGroup: (label: string) => `Модели ${label}`,
      modelsOtherGroup: 'Другие модели',
      modelsCustomGroup: 'Своя модель',
      modelsRefresh: 'Обновить список моделей',
      modelsError: (msg: string) => `Список моделей недоступен: ${msg}`,
      resolvedNow: (model: string) => `Сейчас используется: ${model}`,
      effort: 'Глубина рассуждений',
      defaultTier: 'Уровень для новых чатов',
      voiceTier: 'Уровень для голосовых запросов',
      behaviorSection: 'Поведение',
      webSearch: 'Поиск в интернете',
      webSearchDesc: 'Встроенный веб-поиск OpenAI для свежих новостей, погоды и фактов (только Responses API).',
      imageDetail: 'Детализация изображений',
      imageDetailDesc: 'Высокая детализация точнее читает текст на скриншотах, но расходует больше токенов.',
      imageDetailOptions: { auto: 'Авто', low: 'Низкая', high: 'Высокая', original: 'Оригинал' },
      userTitle: 'Как обращаться к вам',
      userTitleDesc: 'Например: сэр, мэм, босс, по имени.',
      userTitlePlaceholder: 'сэр',
      userName: 'Ваше имя',
      userNamePlaceholder: 'Необязательно',
      custom: 'Дополнительные инструкции',
      customDesc: 'Добавляются к характеру Джарвиса: предпочтения, контекст, стиль ответов.',
      customPlaceholder: 'Например: отвечай кратко, я работаю дизайнером в Алматы.'
    },

    voice: {
      providerSection: 'Синтез речи',
      provider: 'Голос Джарвиса',
      providers: { openai: 'OpenAI', elevenlabs: 'ElevenLabs', system: 'Системный' },
      providerDesc: {
        openai: 'Естественные голоса OpenAI с управлением стилем речи.',
        elevenlabs: 'Любой голос из вашего аккаунта ElevenLabs.',
        system: 'Голоса операционной системы: бесплатно и без интернета.'
      },
      openaiVoice: 'Голос',
      ttsModel: 'Модель синтеза',
      speed: 'Скорость речи',
      style: 'Стиль речи',
      styleDesc: 'Инструкции для модели gpt-4o-mini-tts: тембр, темп, интонация.',
      styleReset: 'Стиль Джарвиса',
      styleNotSupported: 'Выбранная модель не поддерживает инструкции стиля.',
      elevenKey: 'API-ключ ElevenLabs',
      elevenKeyPlaceholder: 'Вставьте ключ ElevenLabs',
      elevenKeySaved: 'Ключ ElevenLabs сохранён',
      elevenKeyRemoved: 'Ключ ElevenLabs удалён',
      elevenVoice: 'Голос из аккаунта',
      elevenVoicePick: 'Выберите голос…',
      elevenVoicesLoading: 'Загружаю голоса…',
      elevenVoicesNeedKey: 'Сохраните ключ, чтобы загрузить голоса',
      elevenVoicesEmpty: 'В аккаунте нет голосов',
      elevenVoiceId: 'Voice ID вручную',
      elevenVoiceIdDesc: 'Идентификатор голоса из ElevenLabs Voice Library, если его нет в списке.',
      elevenModel: 'Модель ElevenLabs',
      stability: 'Стабильность',
      stabilityDesc: 'Выше — ровнее и спокойнее, ниже — живее и эмоциональнее.',
      similarity: 'Сходство с голосом',
      similarityDesc: 'Насколько точно сохранять тембр выбранного голоса.',
      elevenSpeedNote: 'ElevenLabs поддерживает скорость от 0,7 до 1,2.',
      rightsHint: 'Используйте голоса, на которые у вас есть права: собственные, созданные вами или из библиотеки с разрешённым использованием.',
      systemVoice: 'Голос системы',
      systemVoiceAuto: 'Автоматически — лучший для языка ответа',
      systemVoicesEmpty: 'Системные голоса не найдены',
      preview: 'Прослушать',
      previewStop: 'Остановить',
      previewing: 'Синтезирую…',
      previewText: (title: string) =>
        `Добрый день${title ? `, ${title}` : ''}. Все системы работают в штатном режиме. Чем могу помочь?`,
      previewFailed: 'Не удалось воспроизвести образец',
      playbackSection: 'Когда говорить',
      speakMode: 'Озвучивать ответы',
      speakModes: {
        voice: 'Только на голосовые запросы',
        always: 'Всегда',
        never: 'Никогда'
      },
      maxSpoken: 'Длина озвучки',
      maxSpokenDesc: 'Длинные ответы озвучиваются частично, остальное — в чате.',
      chars: (n: number) => `${n} симв.`,
      sttSection: 'Распознавание речи',
      sttModel: 'Модель распознавания',
      sttLanguage: 'Язык речи',
      sttLanguages: {
        '': 'Определять автоматически',
        ru: 'Русский',
        en: 'Английский',
        kk: 'Казахский',
        uk: 'Украинский',
        uz: 'Узбекский',
        de: 'Немецкий',
        fr: 'Французский',
        es: 'Испанский',
        tr: 'Турецкий'
      } as Record<string, string>
    },

    activation: {
      engineSection: 'Голосовая активация',
      engineDesc: 'Как Джарвис узнаёт, что вы к нему обращаетесь.',
      engines: {
        local: {
          title: 'Локально',
          desc: 'Распознавание имени прямо на компьютере. Работает без интернета и ничего не отправляет в облако.'
        },
        cloud: {
          title: 'Облако',
          desc: 'Точнее для шумных помещений и акцентов. Фрагменты речи отправляются в OpenAI.'
        },
        off: {
          title: 'Выключено',
          desc: 'Джарвис не слушает микрофон. Команды — по горячей клавише или кнопке.'
        }
      },
      phrases: 'Имена для обращения',
      phrasesDesc: 'Джарвис откликается, если одно из имён прозвучит в начале фразы.',
      phraseAdd: 'Добавить имя',
      phrasePlaceholder: 'Новое имя и Enter',
      phraseRemove: (p: string) => `Удалить «${p}»`,
      phrasesMax: 'Не больше 10 имён',
      sensitivity: 'Чувствительность',
      sensitivities: { low: 'Низкая', medium: 'Средняя', high: 'Высокая' },
      sensitivityDesc: 'Высокая реагирует на неточное произношение, но чаще срабатывает случайно.',
      sessionSection: 'Диалог',
      followUp: 'Ожидание продолжения',
      followUpDesc: 'После ответа можно продолжить без имени в течение этого времени.',
      followUpOff: 'Выключено',
      commandTimeout: 'Ожидание команды',
      commandTimeoutDesc: 'Сколько ждать команду после одного только имени.',
      seconds: (n: number) => `${n} с`,
      acknowledge: 'Отклик на имя',
      acknowledges: { chime: 'Сигнал', voice: 'Голос', both: 'Сигнал и голос' },
      micSection: 'Микрофон',
      mic: 'Устройство ввода',
      micDefault: 'Системный по умолчанию',
      micUnnamed: (i: number) => `Микрофон ${i}`,
      micLevel: 'Уровень сигнала',
      micAllow: 'Разрешить доступ к микрофону',
      micNeedAccess: 'Разрешите доступ к микрофону, чтобы увидеть устройства и проверить уровень.',
      micError: 'Микрофон недоступен',
      hotkeysSection: 'Горячие клавиши',
      hotkeyVoice: 'Сказать команду',
      hotkeyVoiceDesc: 'Джарвис начнёт слушать без имени.',
      hotkeyWindow: 'Показать или скрыть окно',
      hotkeyRecord: 'Нажмите сочетание…',
      hotkeyNone: 'Не задано',
      hotkeyClear: 'Очистить',
      hotkeyEdit: 'Изменить сочетание',
      hotkeyHint: 'Esc — отмена, Backspace — очистить',
      engineError: (e: string) => `Голосовой движок: ${e}`
    },

    computer: {
      controlSection: 'Управление компьютером',
      control: 'Разрешить управление компьютером',
      controlDesc: 'Открывать приложения и сайты, делать скриншоты, нажимать клавиши, управлять мышью и громкостью.',
      confirm: 'Спрашивать перед опасными действиями',
      confirmDesc: 'Выключение, принудительное закрытие программ, перезапись файлов и команды терминала.',
      shell: 'Команды терминала',
      shellDesc: 'Джарвис сможет выполнять команды оболочки. Перед каждой командой показывается подтверждение.',
      permissionsSection: 'Разрешения macOS',
      permissionsDesc: 'Без этих разрешений часть команд работать не будет.',
      permissionsWindows: 'Windows не требует отдельных разрешений для голосового управления.',
      permissions: {
        microphone: { title: 'Микрофон', desc: 'Голосовая активация и диктовка.' },
        screen: { title: 'Запись экрана', desc: 'Скриншоты и разбор того, что на экране.' },
        accessibility: { title: 'Универсальный доступ', desc: 'Нажатия клавиш, ввод текста и управление мышью.' }
      } satisfies Record<PermissionKind, { title: string; desc: string }>,
      states: {
        granted: 'Разрешено',
        denied: 'Запрещено',
        'not-determined': 'Не запрашивалось',
        restricted: 'Ограничено',
        unknown: 'Неизвестно'
      } satisfies Record<PermissionState, string>,
      allow: 'Разрешить',
      openSettings: 'Открыть настройки',
      recheck: 'Проверить снова'
    },

    general: {
      startupSection: 'Запуск',
      launchAtLogin: 'Запускать при входе в систему',
      launchAtLoginDesc: 'Джарвис будет готов откликнуться сразу после включения компьютера.',
      startHidden: 'Запускать свёрнутым',
      startHiddenDesc: 'Окно не открывается при запуске, Джарвис ждёт в фоне.',
      showInDock: 'Показывать в Dock',
      showInDockDesc: 'Если выключено, значок в Dock скрывается вместе с окном.',
      overlaySection: 'Индикатор',
      overlay: 'Показывать индикатор',
      overlayDesc: 'Небольшая панель с сферой, когда Джарвис слушает, думает или говорит.',
      overlayPosition: 'Расположение',
      positions: {
        'top-right': 'Справа сверху',
        'top-center': 'По центру сверху',
        'bottom-center': 'По центру снизу',
        'bottom-right': 'Справа снизу'
      },
      dataSection: 'Данные',
      clearHistory: 'Очистить историю',
      clearHistoryDesc: 'Удалить все чаты и вложения.',
      clearHistoryConfirmTitle: 'Удалить всю историю?',
      clearHistoryConfirmText: 'Все чаты, скриншоты и вложения будут удалены без возможности восстановления.',
      clearHistoryDone: 'История очищена',
      resetSettings: 'Сбросить настройки',
      resetSettingsDesc: 'Вернуть все параметры к значениям по умолчанию. Ключи API сохранятся.',
      resetConfirmTitle: 'Сбросить все настройки?',
      resetConfirmText: 'Все параметры вернутся к значениям по умолчанию. API-ключи останутся.',
      resetDone: 'Настройки сброшены',
      quit: 'Завершить работу',
      quitDesc: 'Закрытие окна оставляет Джарвиса в фоне. Эта кнопка полностью выключает его.'
    },

    about: {
      version: (v: string) => `Версия ${v}`,
      platform: { darwin: 'macOS', win32: 'Windows', linux: 'Linux' },
      guideTitle: 'Как пользоваться',
      guide: [
        { title: 'Позовите по имени', text: 'Скажите «Джарвис» и сразу команду: «Джарвис, открой Telegram».' },
        { title: 'Горячая клавиша', text: 'Нажмите сочетание из раздела «Активация» и говорите без имени.' },
        { title: 'Экран и тесты', text: '«Сделай скриншот и ответь на каждый вопрос» — Джарвис разберёт всё, что видно на экране.' },
        { title: 'Уровни моделей', text: 'Luna — быстрая, Terra — сбалансированная, Sol — максимальная. Переключайте прямо в чате.' },
        { title: 'Работа в фоне', text: 'Закрытие окна не выключает Джарвиса — он остаётся в строке меню или в трее.' }
      ],
      voiceNote:
        'Голос Джарвиса — это стиль речи вежливого британского ИИ-дворецкого. Приложение не копирует и не имитирует голоса реальных людей.',
      tiersTitle: 'Уровни моделей'
    },

    hint: {
      failed: (msg: string) => `Не удалось сохранить: ${msg}`
    }
  },

  overlay: {
    phase: {
      idle: 'Готов',
      wake: 'Да, сэр?',
      listening: 'Слушаю…',
      transcribing: 'Распознаю…',
      thinking: 'Думаю…',
      acting: 'Выполняю…',
      speaking: 'Говорю…',
      error: 'Ошибка'
    } satisfies Record<AssistantPhase, string>,
    done: 'Готово',
    wakeAck: (title: string) => (title ? `Да, ${title}?` : 'Да?'),
    wakeHint: (phrase: string) => `Скажите «${phrase}»`,
    open: 'Открыть чат',
    close: 'Скрыть индикатор',
    label: 'Индикатор Джарвиса'
  }
} as const
