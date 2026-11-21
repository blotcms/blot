Date: 2026-06-16
Tags: Readings
Author: Constance Whitlock
Summary: How a perforation gauge works, with the arithmetic, a table and a short program for measuring a scan.
Bibliography: /_files/references.bib

# Counting holes

The first British stamps had no perforations at all. Clerks cut them from the sheet with scissors, and a great many survive with a margin shaved into the design. Perforating machines came in the 1850s, and with them a question collectors still ask at every meeting: *what gauge is it?*

## The gauge

A stamp's gauge is the number of holes, or teeth, along two centimetres of its edge. The measure was proposed by a French collector, Dr Jacques Legrand, in 1866, and it has stuck because it is easy to check with a printed card and hard to argue with.

If you count $n$ holes along a length of $\ell$ millimetres, the gauge is

$$
g = \frac{20\,n}{\ell}
$$

so twelve holes along fifteen millimetres is $g = 20 \times 12 / 15 = 16$. In practice gauges are quoted to the nearest half: a stamp is *perf 14* or *perf 15½*, never *perf 14.37*.

A stamp perforated differently along its sides and along its top and bottom is a *compound* perforation, written horizontal first: *perf 11 × 10½*.

### Gauges you will meet

| Stamp | Year | Gauge |
| --- | ---: | ---: |
| Great Britain, Penny Red | 1854 | 16 |
| Great Britain, Penny Red | 1855 | 14 |
| United States, first perforated issues | 1857 | 15½ |
| United States, most definitives | 1890s | 12 |

==The difference between 16 and 14 on a Penny Red can be the difference between a common stamp and a scarce one==, which is why the gauge in the library is chained to the table.^[It is a plain card gauge, the kind dealers give away. It was chained after the second one walked.]

## Measuring a scan

Leonard measures his stamps from scans rather than by eye. He marks the centre of each hole along one edge and lets a few lines of Python do the rest. The scanner's resolution, `dpi`, turns pixels into millimetres:

```python
def gauge(hole_centres, dpi):
    """Holes per 20 mm, from the x positions (in pixels) of hole centres."""
    first, last = hole_centres[0], hole_centres[-1]
    length_mm = (last - first) / dpi * 25.4
    holes = len(hole_centres) - 1
    return round(holes * 20 / length_mm * 2) / 2   # to the nearest half

print(gauge([12, 71, 130, 189, 248, 307, 366, 425, 484], dpi=1200))   # 16.0
```

The rounding is the important line. A scan is never perfectly square, and a reading of 15.8 almost certainly means 16. If you would rather not program, the same arithmetic in a spreadsheet is:

    =ROUND(20 * (COUNT(A:A) - 1) / ((MAX(A:A) - MIN(A:A)) / 1200 * 25.4) * 2, 0) / 2

## Further reading

*Household Words* noticed the machines early. "The Queen's Head" tells how Henry Archer offered the Treasury his perforating machine, and how little he was paid for it [@queenshead]. For what the stamps then carried, see the magazine's pieces on the post to Australia and on how a government office keeps the letters it receives [@australia; @letters].
