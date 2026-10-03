import { register } from 'node:module';
import './redis.mjs'; // заглушка Redis ставится до загрузки api/_db.js (он запоминает fetch при импорте)
register('./hooks.mjs', import.meta.url);
