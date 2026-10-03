// Этап 1: словарь магазинов, поиск, ответ по магазину, эталон /cashback.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setEnv } from './helpers.mjs';

setEnv();
const { CATS } = await import('../api/_lib.js');
const shops = await import('../api/_shops.js');
const bot = await import('../api/_bot.js');
const { lookup, norm, oneEdit, SHOPS } = shops;

const DOC = {
  "months": {
    "2026-10": {
      "zhanna": [
        {
          "bank": "otp",
          "items": [
            {
              "cat": "Супермаркеты",
              "pct": "5"
            },
            {
              "cat": "Маркетплейсы",
              "pct": "12"
            },
            {
              "cat": "Все покупки",
              "pct": "1"
            }
          ]
        },
        {
          "bank": "halva",
          "items": [
            {
              "cat": "Маркетплейсы",
              "pct": "5"
            },
            {
              "cat": "Кафе и рестораны",
              "pct": "1.5"
            }
          ]
        }
      ],
      "denis": [
        {
          "bank": "sber",
          "items": [
            {
              "cat": "Супермаркеты",
              "pct": "10"
            },
            {
              "cat": "Моя категория",
              "pct": "3"
            },
            {
              "cat": "Маркетплейсы",
              "pct": "1.5"
            }
          ]
        },
        {
          "bank": "alfa",
          "items": [
            {
              "cat": "Супермаркеты",
              "pct": "5"
            },
            {
              "cat": "Маркетплейсы",
              "pct": "5"
            }
          ]
        },
        {
          "bank": "vtb",
          "items": [
            {
              "cat": "Маркетплейсы",
              "pct": "5"
            }
          ]
        }
      ]
    },
    "2026-11": {
      "zhanna": [
        {
          "bank": "otp",
          "items": [
            {
              "cat": "АЗС",
              "pct": "7"
            }
          ]
        }
      ],
      "denis": []
    },
    "2026-09": {
      "zhanna": [],
      "denis": [
        {
          "bank": "sber",
          "items": [
            {
              "cat": "Книги",
              "pct": "2"
            }
          ]
        }
      ]
    }
  },
  "custom": [
    "Моя категория"
  ]
};
const OCT = '2026-10';
const ask = (q, mo = OCT, custom = DOC.custom) => bot.shopText(DOC, mo, lookup(q, custom));

/* ---------- эталон: вывод /cashback не изменился после выноса общей функции ---------- */
// Строки сняты с исходного monthText до рефакторинга; заголовок «Кэшбэки» (с 2026-10-03), остальное без изменений.
test('monthText и cashbackTexts: вывод совпадает с эталоном старого кода', () => {
  assert.equal(bot.monthText(DOC, OCT), "Кэшбэки, Октябрь 2026\n\nВсе покупки\n1% — Жанна: ОТП\n\nКафе и рестораны\n1,5% — Жанна: Халва\n\nМаркетплейсы\n✅ 12% — Жанна: ОТП\n5% — Жанна: Халва · Денис: Альфа, ВТБ\n1,5% — Денис: Сбер\n\nМоя категория\n3% — Денис: Сбер\n\nСупермаркеты\n✅ 10% — Денис: Сбер\n5% — Жанна: ОТП · Денис: Альфа");
  assert.equal(bot.monthText(DOC, '2026-11'), "Кэшбэки, Ноябрь 2026\n\nАЗС\n7% — Жанна: ОТП\n\nДенис: пока не заполнено");
  assert.equal(bot.monthText(DOC, '2026-09'), "Кэшбэки, Сентябрь 2026\n\nКниги\n2% — Денис: Сбер\n\nЖанна: пока не заполнено");
  assert.equal(bot.monthText(DOC, '2026-12'), "Кэшбэки, Декабрь 2026\n\nПока не заполнено");
  const t = bot.cashbackTexts(DOC, OCT);
  assert.equal(t.length, 2);
  assert.equal(t[0], bot.monthText(DOC, OCT));
  assert.equal(t[1], bot.monthText(DOC, '2026-11'));
});

/* ---------- словарь ---------- */
test('словарь: 80+ магазинов, все категории из CATS, ключи не пересекаются', () => {
  assert.ok(SHOPS.length >= 80, 'магазинов: ' + SHOPS.length);
  const owner = new Map();
  for (const c of CATS) owner.set(norm(c), 'категория ' + c);
  for (const [name, cats, aliases] of SHOPS) {
    for (const c of cats.split('+')) assert.ok(CATS.includes(c), name + ': нет категории ' + c);
    for (const k of new Set([name].concat(aliases).map(norm))) {
      assert.ok(k, name + ': пустой ключ');
      assert.ok(!owner.has(k) || owner.get(k) === name, 'ключ «' + k + '» занят: ' + owner.get(k) + ' и ' + name);
      owner.set(k, name);
    }
  }
});

test('норма: регистр, ё, знаки, пробелы', () => {
  assert.equal(norm('  ПЯТЁРОЧКА!!!  '), 'пятерочка');
  assert.equal(norm('Красное&Белое'), 'красное белое');
  assert.equal(norm('36,6'), '36 6');
  assert.equal(norm('Вкусно — и точка'), 'вкусно и точка');
  assert.equal(norm(null), '');
});

test('oneEdit: замена, вставка, удаление, перестановка; две правки нет', () => {
  assert.ok(oneEdit('лента', 'ленто'));
  assert.ok(oneEdit('лента', 'лент'));
  assert.ok(oneEdit('лента', 'ленфта'));
  assert.ok(oneEdit('лента', 'лнета'));
  assert.ok(!oneEdit('лента', 'лонто'));
  assert.ok(!oneEdit('лента', 'ле'));
});

/* ---------- поиск ---------- */
test('поиск: точное совпадение, регистр, ё, знаки', () => {
  for (const q of ['Пятёрочка', 'пятерочка', 'ПЯТЁРОЧКА!!!', '  пятерочка  ']) {
    const r = lookup(q, []);
    assert.deepEqual([r.kind, r.title, r.cats], ['found', 'Пятёрочка', ['Супермаркеты']], q);
  }
});

test('поиск: латиница = кириллица', () => {
  assert.equal(lookup('ozon', []).title, 'Ozon');
  assert.equal(lookup('озон', []).title, 'Ozon');
  assert.equal(lookup('Вайлдберриз', []).title, 'Wildberries');
  assert.equal(lookup('wb', []).title, 'Wildberries');
  assert.equal(lookup('Ламода', []).cats[0], 'Маркетплейсы');
  assert.equal(lookup('красное и белое', []).title, 'Красное&Белое');
  assert.equal(lookup('пицца фабрика', []).title, 'Пиццафабрика');
  assert.equal(lookup('донер в пите', []).cats[0], 'Фастфуд');
  assert.equal(lookup('бристоль', []).cats[0], 'Супермаркеты');
});

test('поиск: вхождение по границам слов, от 3 символов', () => {
  assert.equal(lookup('пятерочка на ленина 5', []).title, 'Пятёрочка');
  assert.equal(lookup('купил в магнит', []).title, 'Магнит');
  assert.equal(lookup('кинг', []).title, 'Бургер Кинг');
  assert.equal(lookup('валентина', []).kind, 'unknown'); // «лента» внутри слова не считается
  assert.equal(lookup('ле', []).kind, 'unknown');
  assert.equal(lookup('дн', []).kind, 'unknown');
  assert.equal(lookup('го', []).kind, 'unknown'); // слово «го» есть в «Яндекс Го», но 2 символа — только точное совпадение
  assert.equal(lookup('кб', []).title, 'Красное&Белое'); // короткий алиас работает как точный
  assert.equal(lookup('купил в кб', []).kind, 'unknown'); // двухсимвольное имя внутри фразы не ищем
});

test('поиск: одна опечатка только в словах от 5 букв', () => {
  assert.equal(lookup('пятерчка', []).title, 'Пятёрочка'); // пропуск буквы
  assert.equal(lookup('перекрёстак', []).title, 'Перекрёсток'); // замена
  assert.equal(lookup('магнти', []).title, 'Магнит'); // перестановка
  assert.equal(lookup('ленто', []).title, 'Лента');
  assert.equal(lookup('мтк', []).kind, 'unknown'); // 3 буквы: опечатки не прощаем
  assert.equal(lookup('ашаг', []).kind, 'unknown'); // 4 буквы, одна правка до «Ашан»: всё равно не угадываем
  assert.equal(lookup('ubar', []).kind, 'unknown'); // 4 буквы, одна правка до «Uber»
  assert.equal(lookup('ашан', []).title, 'Ашан'); // а точное совпадение в 4 буквы работает
  assert.equal(lookup('лента', []).title, 'Лента'); // граница: 5 букв с одной опечаткой уже ищутся (см. «ленто»)
  assert.equal(lookup('лето', []).kind, 'unknown'); // 4 буквы: «лето» не угадывается как «лента»
  assert.equal(lookup('перекрёстаак', []).kind, 'unknown'); // две правки
});

test('поиск: два кандидата → «не знаю», а не угадывание', () => {
  const dict = [['Салат', 'Кафе и рестораны', []], ['Салон', 'Красота', []]];
  const r = lookup('салан', [], dict); // одна правка до обоих
  assert.equal(r.kind, 'ambiguous');
  assert.deepEqual(r.names, ['Салат', 'Салон']);
  const y = lookup('яндекс', []);
  assert.equal(y.kind, 'ambiguous');
  assert.ok(y.names.includes('Яндекс Еда') && y.names.includes('Яндекс Go'));
  // после неоднозначного шага следующие шаги не запускаются
  assert.equal(lookup('салат', [], dict).title, 'Салат');
});

test('поиск: неизвестное и пустое', () => {
  assert.equal(lookup('asdfgh', []).kind, 'unknown');
  assert.equal(lookup('', []).kind, 'unknown');
  assert.equal(lookup('   !!! ', []).kind, 'unknown');
  assert.equal(lookup(undefined, []).kind, 'unknown');
  assert.equal(lookup('а'.repeat(5000), []).kind, 'unknown');
});

test('поиск: несколько категорий у магазина', () => {
  assert.deepEqual(lookup('яндекс еда', []).cats, ['Кафе и рестораны', 'Супермаркеты']);
  assert.deepEqual(lookup('спортмастер', []).cats, ['Одежда и обувь', 'Спорт и фитнес']);
});

test('поиск: название категории, в том числе своей', () => {
  const k = lookup('кафе', []);
  assert.deepEqual([k.kind, k.title, k.byCat, k.cats], ['found', 'Кафе и рестораны', true, ['Кафе и рестораны']]);
  assert.equal(lookup('цветы', []).byCat, true); // категория, а не «Цветы.ру»
  assert.equal(lookup('все покупки', []).title, 'Все покупки');
  const c = lookup('моя категория', ['Моя категория']);
  assert.deepEqual([c.kind, c.title, c.byCat], ['found', 'Моя категория', true]);
  assert.equal(lookup('моя категория', []).kind, 'unknown'); // без своей категории в документе её нет
  assert.equal(lookup('супермаркеты', ['x']).title, 'Супермаркеты');
});

test('поиск: магазин и его же категория в одном запросе → магазин', () => {
  assert.equal(lookup('читай город книги', []).title, 'Читай-город');
});

/* ---------- ответ ---------- */
test('ответ: одна категория, как /cashback, плюс «Все покупки» запасной строкой', () => {
  assert.equal(ask('Пятёрочка'), 'Пятёрочка · Супермаркеты\n✅ 10% — Денис: Сбер\n5% — Жанна: ОТП · Денис: Альфа\nВсе покупки: 1% — Жанна: ОТП');
});

test('ответ: ✅ только когда есть из чего выбирать', () => {
  assert.equal(ask('Читай-город', '2026-09'), 'Читай-город · Книги\n2% — Денис: Сбер');
  assert.deepEqual(bot.pctLines([{ p: 'denis', bank: 'sber', v: 5 }, { p: 'denis', bank: 'alfa', v: 3 }]), ['✅ 5% — Денис: Сбер', '3% — Денис: Альфа']);
  assert.deepEqual(bot.pctLines([{ p: 'denis', bank: 'sber', v: 5 }, { p: 'denis', bank: 'alfa', v: 3 }], false), ['5% — Денис: Сбер', '3% — Денис: Альфа']);
});

test('ответ: несколько категорий — лучшая строка из каждой', () => {
  assert.equal(ask('Яндекс Еда'), 'Яндекс Еда\nКафе и рестораны: 1,5% — Жанна: Халва\nСупермаркеты: ✅ 10% — Денис: Сбер\nВсе покупки: 1% — Жанна: ОТП');
});

test('ответ: запрос по самой категории «Все покупки» без дубля', () => {
  assert.equal(ask('все покупки'), 'Все покупки\n1% — Жанна: ОТП');
});

test('ответ: своя категория', () => {
  assert.equal(ask('моя категория'), 'Моя категория\n3% — Денис: Сбер\nВсе покупки: 1% — Жанна: ОТП');
});

test('ответ: пустой месяц и пустая категория', () => {
  assert.equal(ask('Пятёрочка', '2026-12'), 'Пятёрочка · Супермаркеты\nУ вас нет категории супермаркеты');
  assert.equal(ask('Магнит', '2026-11'), 'Магнит · Супермаркеты\nУ вас нет категории супермаркеты');
  assert.equal(ask('Яндекс Еда', '2026-12'), 'Яндекс Еда\nКафе и рестораны: нет категории\nСупермаркеты: нет категории');
  const empty = { months: {}, custom: [], rev: {} };
  assert.equal(bot.shopText(empty, OCT, lookup('кафе', [])), 'Кафе и рестораны\nУ вас нет категории кафе и рестораны');
});

test('ответ: неизвестный магазин — подсказка, неоднозначный — «не знаю»', () => {
  assert.match(ask('qwertyu'), /^Не знаю такой магазин\. Напишите название категории/);
  assert.match(ask('яндекс'), /^Не знаю точно: Яндекс [^,]+, Яндекс [^,]+, Яндекс .+ и ещё \d+\. Напишите название полностью/);
  assert.equal(bot.shopText(DOC, OCT, { kind: 'ambiguous', names: ['Лента', 'Лето'] }), 'Не знаю точно: Лента или Лето. Напишите название полностью или название категории.');
});

test('ответ: нет категории — «У вас нет категории …», в том числе когда в месяце есть другие категории', () => {
  assert.equal(ask('КФС'), 'KFC · Фастфуд\nУ вас нет категории фастфуд\nВсе покупки: 1% — Жанна: ОТП');
  assert.equal(ask('кфс', '2026-11'), 'KFC · Фастфуд\nУ вас нет категории фастфуд');
  assert.equal(ask('кафе', '2026-11'), 'Кафе и рестораны\nУ вас нет категории кафе и рестораны');
});

test('ответ: аббревиатуры и «Все покупки» в сообщении про отсутствие категории', () => {
  assert.equal(bot.noCategory('АЗС'), 'У вас нет категории АЗС');
  assert.equal(bot.noCategory('Все покупки'), 'У вас нет категории все покупки');
  assert.equal(bot.noCategory('Я'), 'У вас нет категории я');
  assert.equal(ask('лукойл', '2026-09'), 'Лукойл · АЗС\nУ вас нет категории АЗС');
  assert.equal(ask('все покупки', '2026-11'), 'Все покупки\nУ вас нет категории все покупки');
});

test('ответ: несколько категорий — у отсутствующей «нет категории», у заполненной лучшая строка', () => {
  assert.equal(ask('Яндекс Еда', '2026-10').split('\n')[1], 'Кафе и рестораны: 1,5% — Жанна: Халва');
  const only = { months: { '2026-10': { zhanna: [{ bank: 'otp', items: [{ cat: 'Супермаркеты', pct: '5' }] }], denis: [] } }, custom: [] };
  assert.equal(bot.shopText(only, OCT, lookup('Яндекс Еда', [])), 'Яндекс Еда\nКафе и рестораны: нет категории\nСупермаркеты: 5% — Жанна: ОТП');
});

test('/cashback: «Пока не заполнено» для пустого месяца остаётся как было', () => {
  assert.equal(bot.monthText(DOC, '2026-12'), 'Кэшбэки, Декабрь 2026\n\nПока не заполнено');
});
