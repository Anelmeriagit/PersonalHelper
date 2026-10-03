// Сервис-воркер нужен только для уведомлений о сбросе (на Android и в установленном приложении
// `new Notification()` не работает, нужен `registration.showNotification()`). Ничего не кеширует и запросы не перехватывает.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) if ('focus' in list[i]) return list[i].focus();
    return self.clients.openWindow('/#agent');
  }));
});
