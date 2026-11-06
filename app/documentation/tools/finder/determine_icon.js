module.exports = function extension (filename) {
  
  if (filename.indexOf('.') === -1) return 'folder';

  var extension = filename.slice(filename.lastIndexOf('.') + 1);

  if (['jpg', 'jpeg', 'gif', 'png'].indexOf(extension) > -1)
    extension = 'img';

  if (['css', 'js'].indexOf(extension) > -1)
    extension = 'md';

  return extension;
};