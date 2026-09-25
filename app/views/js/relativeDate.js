var relativeDate = (function(undefined){

  var SECOND = 1000,
      MINUTE = 60 * SECOND,
      HOUR = 60 * MINUTE,
      DAY = 24 * HOUR,
      WEEK = 7 * DAY,
      YEAR = DAY * 365,
      MONTH = YEAR / 12;

  var formats = [
    [ 0.7 * MINUTE, 'A few seconds ago' ],
    [ 1.5 * MINUTE, '1 minute ago' ],
    [ 60 * MINUTE, 'minutes ago', MINUTE ],
    [ 1.5 * HOUR, '1 hour ago' ],
    [ DAY, 'hours ago', HOUR ],
    [ 2 * DAY, '1 day ago' ],
    [ 7 * DAY, 'days ago', DAY ],
    [ 1.5 * WEEK, '1 week ago'],
    [ MONTH, 'weeks ago', WEEK ],
    [ 1.5 * MONTH, '1 month ago' ],
    [ YEAR, 'months ago', MONTH ],
    [ 1.5 * YEAR, '1 year ago' ],
    [ Number.MAX_VALUE, 'years ago', YEAR ]
  ];

  function relativeDate(input,reference){
    !reference && ( reference = (new Date).getTime() );
    reference instanceof Date && ( reference = reference.getTime() );
    input instanceof Date && ( input = input.getTime() );
    
    var delta = reference - input,
        format, i, len;

    for(i = -1, len=formats.length; ++i < len; ){
      format = formats[i];
      if(delta < format[0]){
        return format[2] == undefined ? format[1] : Math.round(delta/format[2]) + ' ' + format[1];
      }
    };
  }

  return relativeDate;

})();

var dates = document.querySelectorAll('[date-from-now]');
  
dates.forEach(function(el){
  var dateStamp = parseInt(el.getAttribute('date-from-now'));
  if (isNaN(dateStamp))
    return;
  if (Date.now() - dateStamp > 1000*60*60*24*30*3)
    return;
  var new_str = relativeDate(new Date(dateStamp));
  el.innerHTML = new_str;
});
