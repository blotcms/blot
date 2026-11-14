module.exports = {
  bees: {
    title: "Bees",
    template: "SITE:studio",
    menu: [
      { url: "/", label: "Home", id: "home" },
      { url: "/archives", label: "Archives", id: "archives" },
      { url: "/search", label: "Search", id: "search" },
      { url: "/about", label: "About", id: "/Pages/About.txt" },
    ],
  },
  clara: {
    title: "Clara Xiao",
    template: "SITE:cv",
  },
  david: {
    title: "David",
    template: "SITE:blog",
  },
  notes: {
    title: "David",
    template: "SITE:blog",
  },
  documentation: {
    title: "Documentation",
    template: "SITE:documentation",
  },
  lecture: {
    title: "The Cartography of Solitude",
    template: "SITE:event",
    menu: [
      { url: "/", label: "Information", id: "/Landing page.txt" },
      { url: "/speakers", label: "Speakers", id: "/Speakers.txt" },
      { url: "/faqs", label: "FAQs", id: "/FAQs.txt" },
      { url: "/page/1", label: "Announcements", id: "/Announcements.txt" },
      { url: "/tickets", label: "Tickets", id: "/Tickets.txt" },
    ],
  },
  programmer: {
    title: "Programmer",
    template: "SITE:fieldnotes",
  },
  sergey: {
    title: "Sergey Prokudin-Gorsky",
    template: "SITE:album",
  },
  sky: {
    title: "Skies",
    template: "SITE:gallery",
    menu: [
      { url: "/", label: "Home", id: "home" },
      { url: "/archives", label: "Archives", id: "archives" },
      { url: "/search", label: "Search", id: "search" },
      { url: "/about", label: "About", id: "/Pages/About.txt" },
    ],
  },
  hypertext: {
    title: "Richard Waller",
    template: "SITE:hypertext",
    plugins: {
      injectTitle: {
        enabled: true,
        options: {},
      },
      linebreaks: {
        enabled: true,
        options: {},
      },
      wikilinks: {
        enabled: true,
        options: {},
      },
      zoom: {
        enabled: true,
        options: {},
      },
    },
  },
};
