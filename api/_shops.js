import { CATS } from './_lib.js';

/* Словарь «магазин → категории» и поиск по нему. Файл с «_» не считается функцией Vercel (лимит Hobby: 12).
   Названия категорий берутся только из CATS (_lib.js). Строка: [название, 'Категория' или 'Кат1+Кат2', [алиасы]].
   Латиница и кириллица связаны явными алиасами (ozon = озон), автотранслитерации нет: она ненадёжна. */
export const SHOPS = [
  // Супермаркеты
  ['Пятёрочка', 'Супермаркеты', ['pyaterochka', '5ka', '5ка']],
  ['Перекрёсток', 'Супермаркеты', ['perekrestok']],
  ['Магнит', 'Супермаркеты', ['magnit']],
  ['Лента', 'Супермаркеты', ['lenta']],
  ['ВкусВилл', 'Супермаркеты', ['вкус вилл', 'vkusvill']],
  ['Дикси', 'Супермаркеты', ['dixy', 'diksi']],
  ['Ашан', 'Супермаркеты', ['auchan']],
  ['Самокат', 'Супермаркеты', ['samokat']],
  ['Яндекс Лавка', 'Супермаркеты', ['лавка', 'yandex lavka']],
  ['Купер', 'Супермаркеты', ['сбермаркет', 'сбер маркет', 'sbermarket', 'kuper']],
  ['Красное&Белое', 'Супермаркеты', ['красное и белое', 'кб', 'к&б']],
  ['Бристоль', 'Супермаркеты', ['bristol']],
  // Фастфуд
  ['Макдоналдс', 'Фастфуд', ['макдональдс', 'макдак', 'mcdonalds', 'mcdonald\'s']],
  ['Вкусно — и точка', 'Фастфуд', []],
  ['KFC', 'Фастфуд', ['кфс', 'кфц']],
  ['Бургер Кинг', 'Фастфуд', ['burger king', 'burgerking']],
  ['Пиццафабрика', 'Фастфуд', ['пицца фабрика', 'pizzafabrika', 'pizza fabrika']],
  ['Донер в пите', 'Фастфуд', []],
  // Кафе и рестораны
  ['Шоколадница', 'Кафе и рестораны', ['shokoladnitsa']],
  ['Кофемания', 'Кафе и рестораны', ['kofemania']],
  ['Surf Coffee', 'Кафе и рестораны', ['серф кофе', 'сёрф кофе']],
  ['Тануки', 'Кафе и рестораны', ['tanuki']],
  ['Яндекс Еда', 'Кафе и рестораны+Супермаркеты', ['yandex eda', 'yandex food']],
  // Аптеки
  ['Ригла', 'Аптеки', ['rigla']],
  ['36,6', 'Аптеки', []],
  ['Аптека.ру', 'Аптеки', ['apteka.ru']],
  ['Горздрав', 'Аптеки', ['gorzdrav']],
  // Здоровье и медицина
  ['Инвитро', 'Здоровье и медицина', ['invitro', 'in vitro']],
  ['Гемотест', 'Здоровье и медицина', ['gemotest']],
  // Маркетплейсы
  ['Ozon', 'Маркетплейсы', ['озон']],
  ['Wildberries', 'Маркетплейсы', ['вайлдберриз', 'вайлдберрис', 'вб', 'wb']],
  ['Яндекс Маркет', 'Маркетплейсы', ['yandex market']],
  ['Мегамаркет', 'Маркетплейсы', ['мега маркет', 'megamarket', 'сбермегамаркет', 'сбер мегамаркет']],
  ['AliExpress', 'Маркетплейсы', ['алиэкспресс', 'али экспресс', 'али']],
  ['Lamoda', 'Маркетплейсы', ['ламода']],
  // Одежда и обувь
  ['Befree', 'Одежда и обувь', ['бифри']],
  ['Gloria Jeans', 'Одежда и обувь', ['глория джинс']],
  ['Familia', 'Одежда и обувь', ['фамилия']],
  ['Спортмастер', 'Одежда и обувь+Спорт и фитнес', ['sportmaster']],
  // Техника и электроника
  ['М.Видео', 'Техника и электроника', ['мвидео', 'mvideo', 'm video']],
  ['Эльдорадо', 'Техника и электроника', ['eldorado']],
  ['DNS', 'Техника и электроника', ['днс']],
  ['Ситилинк', 'Техника и электроника', ['citilink', 'сити линк']],
  // Дом и ремонт
  ['Леруа Мерлен', 'Дом и ремонт', ['леруа', 'leroy merlin']],
  ['Петрович', 'Дом и ремонт', ['petrovich']],
  ['OBI', 'Дом и ремонт', ['оби']],
  ['Hoff', 'Дом и ремонт', ['хофф']],
  // Животные и зоотовары
  ['Четыре лапы', 'Животные и зоотовары', ['4 лапы', '4лапы']],
  ['Бетховен', 'Животные и зоотовары', []],
  ['Зоозавр', 'Животные и зоотовары', ['zoozavr']],
  // Красота
  ['Золотое яблоко', 'Красота', ['gold apple', 'goldapple']],
  ['Летуаль', 'Красота', ['letoile']],
  ['Рив Гош', 'Красота', ['ривгош', 'rive gauche']],
  ['Иль де Ботэ', 'Красота', ['иль де боте', 'ильдеботэ']],
  // Книги
  ['Читай-город', 'Книги', ['читайгород']],
  ['Лабиринт', 'Книги', ['labirint']],
  ['Буквоед', 'Книги', ['bukvoed']],
  // Цветы
  ['Цветы.ру', 'Цветы', ['flowers.ru']],
  ['Flowwow', 'Цветы', ['флаувау', 'флоувау']],
  // АЗС
  ['Лукойл', 'АЗС', ['lukoil']],
  ['Газпромнефть', 'АЗС', ['газпром нефть', 'gazpromneft']],
  ['Роснефть', 'АЗС', ['rosneft']],
  ['Татнефть', 'АЗС', ['tatneft']],
  // Такси и каршеринг
  ['Яндекс Go', 'Такси и каршеринг', ['яндекс го', 'яндекс такси', 'yandex go', 'yandex taxi']],
  ['Uber', 'Такси и каршеринг', ['убер']],
  ['Ситимобил', 'Такси и каршеринг', ['сити мобил', 'citymobil']],
  ['Делимобиль', 'Такси и каршеринг', ['delimobil']],
  ['Яндекс Драйв', 'Такси и каршеринг', ['yandex drive']],
  // Транспорт
  ['РЖД', 'Транспорт', []],
  ['Тройка', 'Транспорт', ['troika']],
  // Путешествия
  ['Аэрофлот', 'Путешествия', ['aeroflot']],
  ['Победа', 'Путешествия', ['pobeda']],
  ['S7', 'Путешествия', ['с7', 's7 airlines']],
  ['Туту', 'Путешествия', ['tutu', 'туту ру', 'tutu.ru']],
  ['Островок', 'Путешествия', ['ostrovok']],
  // Кино и театры
  ['Киномакс', 'Кино и театры', ['kinomax']],
  ['Синема Парк', 'Кино и театры', ['синемапарк', 'cinema park', 'cinemapark']],
  ['Афиша', 'Кино и театры', ['afisha']],
  ['Кассир.ру', 'Кино и театры', ['кассир', 'kassir.ru']],
  // Спорт и фитнес
  ['World Class', 'Спорт и фитнес', ['ворлд класс', 'ворлдкласс', 'worldclass']],
  ['X-Fit', 'Спорт и фитнес', ['икс фит', 'xfit', 'хфит']],
  ['Alex Fitness', 'Спорт и фитнес', ['алекс фитнес', 'alexfitness']],
  // Связь и интернет
  ['МТС', 'Связь и интернет', ['mts']],
  ['Билайн', 'Связь и интернет', ['beeline']],
  ['МегаФон', 'Связь и интернет', ['megafon', 'мега фон']],
  ['Теле2', 'Связь и интернет', ['tele2', 'теле 2', 'т2', 't2']],
  ['Ростелеком', 'Связь и интернет', ['rostelecom']],
  ['Yota', 'Связь и интернет', ['йота']],
  // Цифровые товары и подписки
  ['Яндекс Плюс', 'Цифровые товары и подписки', ['плюс', 'yandex plus']],
  ['Кинопоиск', 'Цифровые товары и подписки', ['kinopoisk']],
  ['Иви', 'Цифровые товары и подписки', ['ivi']],
  ['Okko', 'Цифровые товары и подписки', ['окко']],
  ['Steam', 'Цифровые товары и подписки', ['стим']],
  ['App Store', 'Цифровые товары и подписки', ['апп стор', 'аппстор', 'appstore']],
  // Образование
  ['Skyeng', 'Образование', ['скайенг', 'скаенг']],
  ['Skillbox', 'Образование', ['скиллбокс']],
  ['Яндекс Практикум', 'Образование', ['практикум', 'yandex praktikum']],
  ['Фоксфорд', 'Образование', ['foxford']],
  // Бытовые услуги
  ['Профи.ру', 'Бытовые услуги', ['профи', 'profi.ru']],
  ['СДЭК', 'Бытовые услуги', ['cdek', 'сдек']],
  ['Почта России', 'Бытовые услуги', ['почта', 'pochta']],
  // Авто и автосервис
  ['Fit Service', 'Авто и автосервис', ['фит сервис', 'fitservice', 'фитсервис']],
  ['Exist.ru', 'Авто и автосервис', ['exist', 'экзист']],
  ['Автодок', 'Авто и автосервис', ['autodoc']],
];

// Нормализация: регистр, ё → е, всё кроме букв и цифр → пробел, пробелы сжаты.
export function norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
}
const compact = (s) => s.replace(/ /g, '').length;

// Не больше одной опечатки: замена, вставка, удаление или перестановка соседних букв.
export function oneEdit(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  const s = la < lb ? a : b, l = la < lb ? b : a;
  return s.slice(i) === l.slice(i + 1);
}

// Индекс: ключ (нормализованное название или алиас) → цель. Цель: магазин ('s:Название') или категория ('c:Название').
function buildIndex(shops, cats) {
  const targets = new Map();
  const keys = [];
  for (const [name, catStr, aliases] of shops) {
    const id = 's:' + name;
    targets.set(id, { id, title: name, cats: catStr.split('+'), byCat: false });
    for (const k of new Set([name].concat(aliases || []).map(norm))) if (k) keys.push({ key: k, id });
  }
  for (const c of cats) {
    const id = 'c:' + c;
    targets.set(id, { id, title: c, cats: [c], byCat: true });
    const k = norm(c);
    if (k) keys.push({ key: k, id });
  }
  return { targets, keys };
}

const has = (hay, needle) => (' ' + hay + ' ').includes(' ' + needle + ' ');

// Если нашёлся магазин и его же категория («читай город книги»), оставляем магазин: он точнее.
function settle(ids, targets) {
  const list = [...ids].map((id) => targets.get(id));
  const shopCats = new Set();
  for (const t of list) if (!t.byCat) for (const c of t.cats) shopCats.add(c);
  return list.filter((t) => !(t.byCat && shopCats.has(t.title)));
}

// Результат: {kind:'found', title, cats, byCat} | {kind:'ambiguous', names} | {kind:'unknown'}.
// Порядок: точное совпадение → вхождение по границам слов (от 3 символов) → одна опечатка (слова от 5 символов).
// Если на любом шаге кандидатов больше одного, не угадываем.
export function lookup(query, custom, shops) {
  const { targets, keys } = buildIndex(shops || SHOPS, CATS.concat(Array.isArray(custom) ? custom.filter((c) => typeof c === 'string') : []));
  const q = norm(String(query == null ? '' : query).slice(0, 200));
  if (!q) return { kind: 'unknown' };
  const stages = [
    (k) => k === q,
    (k) => (compact(q) >= 3 && has(k, q)) || (compact(k) >= 3 && has(q, k)),
    (k) => compact(q) >= 5 && compact(k) >= 5 && oneEdit(q, k),
  ];
  for (const match of stages) {
    const ids = new Set();
    for (const e of keys) if (match(e.key)) ids.add(e.id);
    if (!ids.size) continue;
    const found = settle(ids, targets);
    if (found.length === 1) return { kind: 'found', title: found[0].title, cats: found[0].cats.slice(), byCat: found[0].byCat };
    return { kind: 'ambiguous', names: found.map((t) => t.title).sort((a, b) => a.localeCompare(b, 'ru')) };
  }
  return { kind: 'unknown' };
}

/* ---------- обучение: общие псевдонимы и исправления (этап 2) ---------- */
// alias — объект состояния бота: { ключ: { c: категория, t: название для показа, at: время записи } }.
// Ключ: для магазина из словаря norm(его названия) (исправление действует на любое написание), для неизвестного запроса norm(текста).
const OWN = Object.prototype.hasOwnProperty;
export const own = (o, k) => (o && typeof o === 'object' && OWN.call(o, k) ? o[k] : null);
export const shopKey = (s) => norm(String(s == null ? '' : s).slice(0, 100)).slice(0, 60);
// Название для показа из текста пользователя: пробелы сжаты, первая буква заглавная.
export function disp(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 60);
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}
export const validCats = (custom) => [...new Set(CATS.concat(Array.isArray(custom) ? custom.filter((c) => typeof c === 'string' && c) : []))];

// Поиск с учётом псевдонимов. Возвращает { res, key, alias }:
//  res — как у lookup(); key — ключ для псевдонима (null: категория, «не знаю точно» или пустой запрос — учить нечему);
//  alias — запись псевдонима по этому ключу, если есть (даже если категория уже удалена с сайта; тогда она не применяется).
// Словарь важнее псевдонима для неизвестных: псевдоним срабатывает, только если словарь не нашёл ничего.
// Для найденного магазина исправление перекрывает словарь.
export function resolveShop(query, custom, alias) {
  const res = lookup(query, custom);
  const ok = validCats(custom);
  if (res.kind === 'found') {
    if (res.byCat) return { res, key: null, alias: null };
    const key = norm(res.title);
    const a = own(alias, key);
    if (a && typeof a.c === 'string' && ok.includes(a.c)) return { res: { kind: 'found', title: res.title, cats: [a.c], byCat: false }, key, alias: a };
    return { res, key, alias: a };
  }
  if (res.kind === 'unknown') {
    const key = shopKey(query);
    if (!key) return { res, key: null, alias: null };
    const a = own(alias, key);
    if (a && typeof a.c === 'string' && ok.includes(a.c)) return { res: { kind: 'found', title: a.t || disp(query), cats: [a.c], byCat: false }, key, alias: a };
    return { res, key, alias: a };
  }
  return { res, key: null, alias: null };
}
