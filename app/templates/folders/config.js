module.exports = {
  bjorn: {
    title: "Björn Allard",
    template: "SITE:portfolio",
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
      { url: "/", label: "Information",  id: "/Landing page.txt" },
      { url: "/speakers", label: "Speakers",  id: "/Speakers.txt" },
      { url: "/faqs", label: "FAQs", id: "/FAQs.txt" },
      { url: "/page/1", label: "Announcements", id: "/Announcements.txt" },
      { url: "/tickets", label: "Get tickets", id: "/Tickets.txt" },
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
  thoughtforms: {
    title: "Thought-forms",
    template: "SITE:studio",
  },
  hypertext: {
    title: "Richard Waller",
    template: "SITE:hypertext",
    plugins: {
      injectTitle: {
        enabled: true,
        options: {}
      },
      linebreaks: {
        enabled: true,
        options: {}
      },
      zoom: {
        enabled: true,
        options: {}
      }
    }
  },
};
