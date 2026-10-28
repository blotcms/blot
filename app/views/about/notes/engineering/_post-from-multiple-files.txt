https://github.com/Jack000/Expose
https://mail.google.com/mail/u/0/?zx=s4822pgobzlz#inbox/1542a151ea981d82


add support for 'caption file' e.g. img_4010.txt
https://mail.google.com/mail/u/0/?zx=s4822pgobzlz#inbox/15420abdb1d340a4
Want the api to be simple
Entry.src = [..paths..]?
Each file (including album files)
  makeEntry(blog, path, callback)
  Entry.save(path, callback?)
Album posts
 album: true
 if (album) updateAlbum(blog.id, entry.id) //
  <div class="album">
    <div class="album-item">
    {{> html}}
    </div>
  </div>
Can this be considered connected to image caption feature?
How to handle albums inside albums?
Can I accomplish this without introducing entry.type?
Or should I introduce entry.type?