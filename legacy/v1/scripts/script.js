/* created by Szymon Maslanka and mighty power of internets */
var viewportWidth = $(window).width() ;
var viewportHeight = $(window).height();

function resizetoView(){
  viewportWidth = $(window).width() ;
  viewportHeight = $(window).height();
  $('.screen').height(viewportHeight);
  $('#portfolio_screen').height(viewportHeight*1.25);
  $('.screen #footer').width(viewportWidth);
}

$(document).ready( function(){
  //basic resizing so it fits
  resizetoView();
  $(window).bind('resize', resizetoView);

  // scrollr plugin for smooth scrolling and animations + parallax
  var s = skrollr.init({
    'smoothScrolling': true,
    'smoothScrollingDuration': 500,
  });

  // animations!
  $('#div_welcome').addClass('animated fadeInDown');

  // mail sending scripts
  $('#contact-submit').click(function() {
    var name = $('[name=name]').val();
    var email = $('[name=email]').val();
    var text = $('[name=text]').val();

    $.ajax({
      url: 'mail.php',
      type: 'POST',
      data: { name: name, text: text ,email: email }
    }).success(function(msg){
      feedback = msg;
      console.log(feedback);
      $('#text, #email, #name').val(""); 
      $('#contact-submit').prop('value', 'Sent!');
      $('#contact-submit').attr("disabled", true);
      $('#contact-submit').css('cursor', 'default');
    }).error(function(msg){
      feedback = '<p> There was en error </p>';
    })                   
  });

    $(document).on('mousemove', function(e){
      $('#grass1').css('background-position-x',  e.pageX/16);
      $('#grass2').css('background-position-x',  e.pageX/12);
      $('#grass3').css('background-position-x',  e.pageX/8);
    });
});



