var clients = require("clients");
var list = [];

// Build the list of clients for the dashboard
for (var i in clients) {
  list.push({
    name: i,
    display_name: clients[i].display_name,
    description: clients[i].description,
  });
}

list.sort(function (a, b) {
  var textA = a.name.toUpperCase();
  var textB = b.name.toUpperCase();
  return textA < textB ? -1 : textA > textB ? 1 : 0;
});

module.exports = function (req, res, next) {
  res.locals.clients = list.slice();

  const selectedClient =
    (req.params && req.params.client) || req.blog.client || res.locals.effectiveClient;

  if (selectedClient) {
    res.locals.clients = res.locals.clients.map(function (client) {
      client.checked = client.name === selectedClient ? "checked" : "";
      return client;
    });
  } else {
    res.locals.clients[0].checked = "checked";
  }

  next();
};
