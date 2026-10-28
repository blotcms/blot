@@ -0,0 +1,48 @@

// view inherits from
// blog ---> template ---> route

var template = '';
var view = {};
var partials = {};

output = mustache.render(template, view, partials);

view (name)

  template (string)
  options (object) content-type, route, extension
  locals (object)
  partials (object)

on save

  --> check template is valid
  --> extract list of locals and merge with view
  --> extract list of partials

  partials is a flat list

on fetch

  --> get template, view object, partials object

  --> for each in partials object
        fetch partial template, view object and partials
        soft merge view object and partial list and repeat
        Partials can also be entries, look them up but do not render them

  Now we have a template, a complete partials object and a half-finished view object.

  for each in view object

    if is undefined, check to see if it can be automatically retrieved

  Now we have a template, a complete partials object and complete view object.

  For each in view object, check to see if it needs to be rendered



      viewModel = {

        name: 'string',
        template: 'string',

        options: {
          content_type: 'string',
          url: 'string'
        },

        locals: {
          // some of these are just undefined
        },

        partials: {
          // all of these are undefined
        }

      },

      viewModel = {
        name: 'string',
        content: 'string',
        type: 'string',
@@ -180,6 +200,45 @@ module.exports = (function () {
    });
  }

  function get (templateID, viewName, callback) {

    var multi = redis.multi();

    multi.hgetall(viewKey(templateID, viewName));
    multi.hgetall(metadataKey(templateID));

    multi.exec(function(err, response){

      if (err) return callback(err);

      var view = deserialize(response[0], viewModel);
      var theme = deserialize(response[1], metadataModel);

      view.locals = merge(view.locals, theme.locals);

      function retrievePartials (partialName, partialTemplate, next){

        if (view.partials[partialName] !== undefined)
          return next();

        get(templateID, partialName, function(err, partial){

          view.locals = merge(view.locals, partial.locals);
          view.partials[partialName] = partial.content;

          forEach(partial.partials, retrievePartials, next);
        });
      }

      forEach(view.partials, retrievePartials, function(){

        return callback(null, view);
      });
    });
  }
