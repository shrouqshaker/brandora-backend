const {
  controllerRoutes,
  verifyRoutePolicy,
  verifyControllerInventory,
} = require('./controller-route-inventory.cjs');

const routes = controllerRoutes();
test.each(routes)(
  '$verb $route has the reviewed compiled authorization policy',
  (route) => {
    verifyRoutePolicy(route);
  },
);
test('compiled inventory contains 75 routes, 66 protected including internal AI and nine public', () => {
  expect(verifyControllerInventory(routes)).toEqual({
    routes: 75,
    protected: 66,
    public: 9,
    mismatches: 0,
  });
});
